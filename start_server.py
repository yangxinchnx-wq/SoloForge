import http.server
import socketserver
import os
import sys

PORT = 8888

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

def start_server():
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            print(f"Serving at port {PORT}")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("Server stopped")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    start_server()