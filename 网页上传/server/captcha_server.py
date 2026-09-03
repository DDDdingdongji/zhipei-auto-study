# -*- coding: utf-8 -*-
"""
本地验证码识别服务（供「刷课脚本-自动验证版」油猴脚本调用）
============================================================

启动：
    python captcha_server.py
    （默认监听 127.0.0.1:8765，可用环境变量 CAPTCHA_PORT 改端口）

接口：
    GET  /health          健康检查
    POST /solve           识别验证码
        请求 JSON: {"image": "<base64或dataURL>"}
                  或    {"url": "https://.../captcha.png"}   （图片读不到时回退）
                  可选   "type": "auto" | "math" | "digit"
                  可选   "expected_len": 5
        响应 JSON: {"ok": true, "type": "math", "answer": "10",
                    "expression": "2×5", "method": "ddddocr(raw)"}
                  或  {"ok": true, "type": "digit", "digits": "83642", ...}
                  或  {"ok": false, "error": "..."}

原理：调用 auto_captcha.py（ddddocr → RapidOCR → 模板匹配三级识别）。
"""
import base64
import json
import os
import re
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from auto_captcha import auto_solve, solve_math_captcha, solve_digit_captcha

PORT = int(os.environ.get('CAPTCHA_PORT', '8765'))
MAX_BODY = 8 * 1024 * 1024


def decode_image(b64):
    """base64（支持 dataURL 前缀）-> 图片 bytes。"""
    b64 = (b64 or '').strip()
    m = re.match(r'^data:image/[^;]+;base64,(.+)$', b64, re.S)
    if m:
        b64 = m.group(1)
    raw = base64.b64decode(b64)
    if len(raw) > MAX_BODY:
        raise ValueError('图片过大')
    return raw


def fetch_url(url, timeout=12):
    """服务端回退方案：直接按 URL 拉验证码图片。"""
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/126.0 Safari/537.36',
            'Referer': 'https://jiangxi.zhipeizaixian.com/',
        },
    )
    return urllib.request.urlopen(req, timeout=timeout).read()


class Handler(BaseHTTPRequestHandler):
    server_version = 'CaptchaOCR/1.0'

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'ok': True, 'service': 'captcha-ocr'})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/solve'):
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
            if length <= 0 or length > MAX_BODY:
                raise ValueError('请求体过大或为空')
            payload = json.loads(self.rfile.read(length).decode('utf-8'))

            if payload.get('image'):
                img_bytes = decode_image(payload['image'])
            elif payload.get('url'):
                img_bytes = fetch_url(payload['url'])
            else:
                raise ValueError('缺少 image 或 url 字段')

            kind = payload.get('type', 'auto')
            expected_len = int(payload.get('expected_len', 5))

            if kind == 'math':
                r = solve_math_captcha(img_bytes)
                result = {'ok': r['answer'] is not None, 'type': 'math', **r}
            elif kind == 'digit':
                r = solve_digit_captcha(img_bytes, expected_len)
                result = {'ok': r['digits'] is not None, 'type': 'digit', **r}
            else:
                r = auto_solve(img_bytes, expected_len=expected_len)
                result = {'ok': r['type'] is not None, **r}

            log = {k: v for k, v in result.items() if k != 'image'}
            print('[OCR]', json.dumps(log, ensure_ascii=False))
            self._send(200, result)

        except Exception as e:  # noqa: BLE001
            print('[OCR] error:', repr(e))
            self._send(200, {
                'ok': False, 'type': None,
                'answer': None, 'digits': None,
                'expression': None, 'method': None,
                'error': str(e),
            })

    def log_message(self, fmt, *args):
        pass


def main():
    srv = HTTPServer(('127.0.0.1', PORT), Handler)
    print('验证码识别服务已启动: http://127.0.0.1:%d/solve' % PORT)
    print('供油猴脚本调用，Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
