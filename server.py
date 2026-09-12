import html
import json
import os
import re
import sys
import traceback
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_URL = 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel'

LAST_DIAGNOSTIC = {
    "ok": False, "target": DEFAULT_URL, "status": None, "final_url": None,
    "content_type": None, "content_length": 0, "tables": 0, "rows": 0,
    "cells": 0, "links": 0, "browser_generated_links": 0,
    "available_words": 0, "unavailable_words": 0, "title": "",
    "response_preview": "", "error": None,
}

def inspect_upstream_payload(payload):
    decoded = payload.decode("utf-8", errors="replace")
    tables = len(re.findall(r"<table\b", decoded, re.I))
    rows = len(re.findall(r"<tr\b", decoded, re.I))
    cells = len(re.findall(r"<td\b", decoded, re.I))
    links = len(re.findall(r"<a\b[^>]*href\s*=", decoded, re.I))
    browser_links = sum(len(re.findall(p, decoded, re.I)) for p in (
        r"abrirNovoCadastro\s*\(", r"document\.location",
        r"window\.location", r"location\.href"))
    available_words = len(re.findall(r"vagas?\s+dispon[ií]veis?|dispon[ií]vel", decoded, re.I))
    unavailable_words = len(re.findall(
        r"n[aã]o\s+h[aá]\s+vagas?\s+dispon[ií]veis?|sem\s+vagas|indispon[ií]vel|vagas?\s+indispon[ií]veis?",
        decoded, re.I))
    m = re.search(r"<title[^>]*>(.*?)</title>", decoded, re.I | re.S)
    title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    preview = re.sub(r"\s+", " ", decoded[:1200]).strip()
    return {
        "tables": tables, "rows": rows, "cells": cells, "links": links,
        "browser_generated_links": browser_links,
        "available_words": available_words, "unavailable_words": unavailable_words,
        "title": title, "response_preview": preview,
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
        if parsed.path == '/api/debug':
            self.handle_debug()
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

    def handle_debug(self):
        body = json.dumps(LAST_DIAGNOSTIC, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

    def handle_proxy(self, head_only=False):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = query.get('url', [DEFAULT_URL])[0]

        try:
            request = urllib.request.Request(
                target,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel',
                    'Origin': 'https://amcin.e-instituto.com.br',
                    'Upgrade-Insecure-Requests': '1',
                },
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = response.read()
                content_type = response.headers.get_content_type() or 'text/html'
                inspected = inspect_upstream_payload(payload)

                LAST_DIAGNOSTIC.clear()
                LAST_DIAGNOSTIC.update({
                    "ok": True,
                    "target": target,
                    "status": response.status,
                    "final_url": response.geturl(),
                    "content_type": content_type,
                    "content_length": len(payload),
                    "error": None,
                    **inspected,
                })

                print(
                    "[UPSTREAM] "
                    f"status={response.status} final_url={response.geturl()!r} "
                    f"type={content_type!r} bytes={len(payload)} "
                    f"tables={inspected['tables']} rows={inspected['rows']} "
                    f"cells={inspected['cells']} links={inspected['links']} "
                    f"browser_links={inspected['browser_generated_links']} "
                    f"available={inspected['available_words']} "
                    f"unavailable={inspected['unavailable_words']} "
                    f"title={inspected['title']!r}",
                    file=sys.stderr, flush=True
                )

                self.send_response(response.status)
                self.send_header('Content-Type', f'{content_type}; charset=utf-8')
                self._send_cors_headers()
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(payload)
                return
        except Exception as error:
            LAST_DIAGNOSTIC.clear()
            LAST_DIAGNOSTIC.update({
                "ok": False, "target": target, "status": None, "final_url": None,
                "content_type": None, "content_length": 0, "tables": 0, "rows": 0,
                "cells": 0, "links": 0, "browser_generated_links": 0,
                "available_words": 0, "unavailable_words": 0, "title": "",
                "response_preview": "", "error": f"{type(error).__name__}: {error}",
            })
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
