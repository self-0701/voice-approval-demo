import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    serve_files = partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).resolve().parent))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 4173), serve_files)
    except OSError:
        server = ThreadingHTTPServer(('127.0.0.1', 0), serve_files)
    with server:
        url = f'http://127.0.0.1:{server.server_port}/'
        print(url, flush=True)
        if '--no-browser' not in sys.argv:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
