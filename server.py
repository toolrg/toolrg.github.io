import html
import os
import re
import sys
import traceback
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_URL = 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel'


def extract_real_link_from_browser_html(html_content):
    if not html_content or not isinstance(html_content, str):
        return None

    patterns = [
        r"abrirNovoCadastro\s*\(\s*['\"`]+([^'\"`]+)['\"`]+\s*\)",
        r"document\.location\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
        r"window\.location(?:\.href)?\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
        r"location\.href\s*=\s*['\"`]+([^'\"`]+)['\"`]+",
    ]

    for pattern in patterns:
        matches = __import__('re').finditer(pattern, html_content, __import__('re').IGNORECASE)
        for match in matches:
            candidate = match.group(1)
            if not candidate:
                continue

            if 'amcin.e-instituto.com.br' not in candidate and not candidate.startswith('/'):
                continue

            url = candidate.strip()
            if url.startswith('/'):
                url = 'https://amcin.e-instituto.com.br' + url

            if url.startswith('https://amcin.e-instituto.com.br'):
                return url

    return None


class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/check':
            self.handle_proxy()
            return
        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
        self.end_headers()

    def handle_proxy(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = query.get('url', [DEFAULT_URL])[0]

        try:
            request = urllib.request.Request(
                target,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel',
                    'Origin': 'https://amcin.e-instituto.com.br',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'document',
                    'Upgrade-Insecure-Requests': '1',
                    'Connection': 'keep-alive',
                },
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = response.read()
                content_type = response.headers.get_content_type() or 'text/html'
                self.send_response(response.status)
                self.send_header('Content-Type', f'{content_type}; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
                self.end_headers()
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
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
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
