import gzip
import http.cookiejar
import html
import json
import os
import re
import sys
import traceback
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_URL = 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel'
SESSION_COOKIE_JAR = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(SESSION_COOKIE_JAR))

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None


def decode_upstream_payload(payload: bytes, content_encoding: str | None) -> bytes:
    if not payload:
        return payload

    encoding = (content_encoding or '').lower().strip()
    if 'gzip' in encoding:
        try:
            return gzip.decompress(payload)
        except OSError:
            pass
    if 'deflate' in encoding:
        try:
            return zlib.decompress(payload)
        except zlib.error:
            pass
    return payload


def summarize_html_response(html_content: str) -> dict:
    text = html_content or ''
    lowered = text.lower()
    table_count = lowered.count('<table')
    tr_count = lowered.count('<tr')
    td_count = lowered.count('<td')
    has_local = 'local' in lowered or 'posto' in lowered or 'agendamento' in lowered
    has_status = 'dispon' in lowered or 'indispon' in lowered or 'vagas' in lowered
    snippet = text[:800].replace('\r', ' ').replace('\n', ' ')
    return {
        'has_table': '<table' in lowered,
        'table_count': table_count,
        'tr_count': tr_count,
        'td_count': td_count,
        'has_local_like_text': has_local,
        'has_availability_text': has_status,
        'snippet': snippet,
    }


class BrowserLinkHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if not value:
                continue
            lowered = (name or '').lower()
            if lowered in {'href', 'data-link', 'data-url'}:
                candidate = normalize_candidate(value)
                if candidate:
                    self.found.append(candidate)
            if lowered == 'onclick':
                for match in re.finditer(r"(?:abrirNovoCadastro|document\.location|window\.location|location\.href)\s*[:=]?\s*['\"`]+([^'\"`]+)['\"`]+", str(value), flags=re.IGNORECASE):
                    candidate = normalize_candidate(match.group(1))
                    if candidate:
                        self.found.append(candidate)


def normalize_candidate(candidate):
    if not candidate or not isinstance(candidate, str):
        return None

    value = candidate.strip().strip('"\'`')
    if not value:
        return None

    if value.startswith('/'):
        value = 'https://amcin.e-instituto.com.br' + value

    if 'amcin.e-instituto.com.br' not in value:
        return None

    if not value.startswith('http://') and not value.startswith('https://'):
        return None

    return value


def extract_real_link_from_browser_html(html_content):
    if not html_content or not isinstance(html_content, str):
        return None

    candidates = []
    patterns = [
        r"abrirNovoCadastro\s*\(\s*['\"`]+([^'\"`]+)['\"`]+\s*\)",
        r"document\.location\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
        r"window\.location(?:\.href)?\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
        r"location\.href\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
    ]

    for pattern in patterns:
        matches = re.finditer(pattern, html_content, re.IGNORECASE)
        for match in matches:
            candidate = normalize_candidate(match.group(1))
            if candidate:
                candidates.append(candidate)

    parser = BrowserLinkHTMLParser()
    parser.feed(html_content)
    candidates.extend(parser.found)

    seen = set()
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            return candidate

    return None


class AppHandler(SimpleHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/check':
            self.handle_proxy()
            return
        if parsed.path == '/api/table':
            self.handle_live_table()
            return
        if parsed.path in ('', '/', '/health'):
            if parsed.path == '/health':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self._send_cors_headers()
                self.send_header('Content-Length', str(len(b'{"status":"ok"}')))
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
                return
            self.serve_index()
            return
        super().do_GET()

    def do_HEAD(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/check':
            self.handle_proxy(head_only=True)
            return
        if parsed.path in ('', '/'):
            self.serve_index(head_only=True)
            return
        super().do_HEAD()

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def serve_index(self, head_only=False):
        index_path = ROOT / 'index.html'
        try:
            body = index_path.read_bytes()
        except FileNotFoundError:
            self.send_response(404)
            self._send_cors_headers()
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            if not head_only:
                self.wfile.write(b'index.html not found')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self._send_cors_headers()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def handle_live_table(self, head_only=False):
        if sync_playwright is None:
            body = b'Playwright not installed.'
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self._send_cors_headers()
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = query.get('url', [DEFAULT_URL])[0]

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 1200})
                page.goto(target, wait_until='load', timeout=120000)
                page.wait_for_timeout(2000)
                try:
                    page.wait_for_selector('table tr, .table-row, tr[onclick]', timeout=20000)
                except Exception:
                    pass
                markup = page.evaluate("""
                    () => {
                        const table = document.querySelector('table');
                        if (table) return table.outerHTML;
                        const container = document.querySelector('#locaisAtendimentoContainer');
                        if (container) return container.innerHTML;
                        return document.body.innerHTML;
                    }
                """)
                browser.close()
                body = (markup or '').encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self._send_cors_headers()
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)
                return
        except Exception as error:
            body = ('<html><body><pre>' + html.escape(str(error)) + '</pre></body></html>').encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self._send_cors_headers()
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

    def handle_proxy(self, head_only=False):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = query.get('url', [DEFAULT_URL])[0]
        diagnostic_mode = query.get('diagnostic', ['0'])[0].lower() in {'1', 'true', 'yes'}

        try:
            request = urllib.request.Request(
                target,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'identity',
                    'Referer': 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel',
                    'Origin': 'https://amcin.e-instituto.com.br',
                    'Upgrade-Insecure-Requests': '1',
                },
            )
            with OPENER.open(request, timeout=20) as response:
                payload = response.read()
                encoding = response.headers.get('Content-Encoding') if hasattr(response, 'headers') else None
                payload = decode_upstream_payload(payload, encoding)
                content_type = response.headers.get_content_type() or 'text/html'
                summary = summarize_html_response(payload.decode('utf-8', errors='replace'))

                if diagnostic_mode:
                    meta = {
                        'status': response.status,
                        'target': target,
                        'content_type': content_type,
                        'content_encoding': encoding,
                        'summary': summary,
                    }
                    body = json.dumps(meta, ensure_ascii=False).encode('utf-8')
                    self.send_response(response.status)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self._send_cors_headers()
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    if not head_only:
                        self.wfile.write(body)
                    return

                self.send_response(response.status)
                self.send_header('Content-Type', f'{content_type}; charset=utf-8')
                self._send_cors_headers()
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(payload)
                return
        except Exception as error:
            print(f'Proxy upstream failure for {target}: {type(error).__name__}: {error}', file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            body = (
                '<html><body><pre>'
                + html.escape(str(error))
                + '</pre></body></html>'
            ).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self._send_cors_headers()
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

    def log_message(self, format, *args):
        return


def main():
    os.chdir(ROOT)
    port = int(os.environ.get('PORT', '5500'))
    host = os.environ.get('HOST', '0.0.0.0')
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f'Server ativo em http://{host}:{port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
