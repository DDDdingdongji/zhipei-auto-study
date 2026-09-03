# -*- coding: utf-8 -*-
"""
自动验证码识别模块 v2（供刷课脚本集成）
=====================================

与 v1 相比的升级（针对“部分验证码识别不了”）：

1. 修复 RGBA 透明底图片被转成黑底的问题（alpha 合成到白底）。
2. ddddocr 双模型（新版 common.onnx + 旧版 common_old.onnx）同时参与识别，
   相当于两个独立投票人。
3. 字符集限制（set_ranges）：数字码强制只输出 0-9，算式码只输出
   数字与运算符，把“目/日/E/=”之类干扰字符直接过滤掉。
4. 预处理变体扩充：原图 / 2x 3x 放大 / 反色 / Otsu / 反色Otsu /
   自适应阈值 / CLAHE / 中值去噪+Otsu，覆盖透明底、浅字深底、
   细笔画、彩色干扰等常见情况。
5. 结果投票：多个引擎 × 多个变体对算式/数字串投票，取加权多数，
   返回 agreement（一致度）与 candidates（候选明细）便于排查。
6. 逐字形兜底升级：投影切字后，每个字形由 ddddocr(限定字符集) +
   RapidOCR + 字体模板(灰度相关+孔洞特征) 三方投票；
   算式模式额外对运算符做 结构特征(+/-/×/÷) + 模板 专项判别，
   解决 ÷ 被误读为 4 的问题。
7. 数字码严格校验位数：只有精确匹配期望位数或逐字形完整识别才返回，
   宁可失败（由脚本“换一张”重试）也不填错答案。

接口保持不变：
    solve_math_captcha(img)  -> dict(answer, expression, method, confidence,
                                      agreement, candidates, raw_text)
    solve_digit_captcha(img, expected_len=5) -> dict(digits, method, confidence,
                                      agreement, candidates, raw_text)
    auto_solve(img, prefer='math', expected_len=5) -> dict(type, ...)
"""

import contextlib
import io as _io
import os
import re
import sys
import threading

_loaded_pylibs = False


def _ensure_pylibs():
    global _loaded_pylibs
    if _loaded_pylibs:
        return
    _loaded_pylibs = True
    try:
        import numpy  # noqa: F401
        import cv2  # noqa: F401
        return
    except ImportError:
        pass
    cands = [
        os.environ.get('AUTO_CAPTCHA_LIBS'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pylibs'),
        os.path.join(os.getcwd(), 'pylibs'),
    ]
    for c in cands:
        if c and os.path.isdir(c):
            if c not in sys.path:
                sys.path.insert(0, c)
            break


_ensure_pylibs()

import numpy as np
import cv2
from PIL import Image

if not hasattr(Image, 'ANTIALIAS'):
    Image.ANTIALIAS = Image.LANCZOS

try:
    import onnxruntime as _ort
    _ort.set_default_logger_severity(3)
except Exception:  # noqa: BLE001
    pass

try:
    with contextlib.redirect_stdout(_io.StringIO()), \
         contextlib.redirect_stderr(_io.StringIO()):
        import ddddocr
    _HAS_DDDDOCR = True
except Exception:  # noqa: BLE001
    ddddocr = None
    _HAS_DDDDOCR = False

try:
    from rapidocr_onnxruntime import RapidOCR
    _HAS_RAPIDOCR = True
except Exception:  # noqa: BLE001
    RapidOCR = None
    _HAS_RAPIDOCR = False

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

DIGIT_CHARSET = '0123456789'
MATH_CHARSET = '0123456789+-×÷xX*?'

_tls = threading.local()


def _get_ddddocr(old=False):
    if not _HAS_DDDDOCR:
        return None
    key = 'ddddocr_old' if old else 'ddddocr_new'
    ocr = getattr(_tls, key, None)
    if ocr is None:
        with contextlib.redirect_stdout(_io.StringIO()), \
             contextlib.redirect_stderr(_io.StringIO()):
            ocr = ddddocr.DdddOcr(old=old, show_ad=False)
        setattr(_tls, key, ocr)
    return ocr


def _get_rapidocr():
    if not _HAS_RAPIDOCR:
        return None
    ocr = getattr(_tls, 'rapidocr', None)
    if ocr is None:
        ocr = RapidOCR()
        _tls.rapidocr = ocr
    return ocr


# --------------------------------------------------------------------------
# 图像工具
# --------------------------------------------------------------------------

def _load_image(src):
    """路径 / bytes / PIL.Image / np.ndarray -> 灰度 uint8。

    RGBA 图片先与白底做 alpha 合成，避免透明底验证码变黑底。
    """
    if isinstance(src, np.ndarray):
        img = src
    elif isinstance(src, Image.Image):
        img = np.array(src)
    elif isinstance(src, (bytes, bytearray)):
        buf = np.frombuffer(bytes(src), dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError('无法解码图片 bytes')
    elif isinstance(src, (str, os.PathLike)):
        data = np.fromfile(str(src), dtype=np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError('无法读取图片: %s' % src)
    else:
        raise TypeError('不支持的图片类型: %s' % type(src))

    if img.ndim == 3 and img.shape[2] == 4:
        # alpha 合成到白底
        bgra = img.astype(np.float32)
        alpha = bgra[..., 3:4] / 255.0
        composited = bgra[..., :3] * alpha + 255.0 * (1.0 - alpha)
        img = cv2.cvtColor(composited.astype(np.uint8),
                           cv2.COLOR_BGR2GRAY)
    elif img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    elif img.ndim != 2:
        raise ValueError('异常图片维度: %s' % (img.shape,))
    return img


def _to_png_bytes(img):
    img = np.ascontiguousarray(img)
    ok, buf = cv2.imencode('.png', img)
    if not ok:
        raise ValueError('图像编码失败')
    return buf.tobytes()


def _preprocess_variants(gray):
    """一组预处理变体（覆盖透明底/反色/细笔画/噪声等场景）。"""
    variants = [('raw', gray)]
    h, w = gray.shape
    if max(h, w) < 400:
        for k in (2, 3):
            variants.append(('up%d' % k,
                             cv2.resize(gray, None, fx=k, fy=k,
                                        interpolation=cv2.INTER_CUBIC)))
    variants.append(('inv', 255 - gray))

    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, thr = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(('otsu', thr))
    variants.append(('otsu_inv', 255 - thr))

    adapt = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 31, 10)
    variants.append(('adapt', adapt))

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    variants.append(('clahe', clahe.apply(gray)))

    med = cv2.medianBlur(gray, 3)
    _, mthr = cv2.threshold(med, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(('med_otsu', mthr))
    return variants


# --------------------------------------------------------------------------
# 表达式解析与计算
# --------------------------------------------------------------------------

_MAP = {
    'x': '×', 'X': '×', '*': '×', '·': '×', '＊': '×',
    '÷': '÷', '/': '÷', '／': '÷',
    '＋': '+',
    '－': '-', '–': '-', '—': '-',
    '＝': '=', '﹦': '=',
    '？': '?', '?': '?',
    '（': '', '）': '', '(': '', ')': '', ' ': '',
}

_EXPR_RE = re.compile(r'(\d{1,2})\s*([+\-×÷])\s*(\d{1,2})')


def _normalize(text):
    out = []
    for ch in text or '':
        out.append(_MAP.get(ch, ch))
    return ''.join(out)


def _parse_expression(text):
    norm = _normalize(text)
    m = _EXPR_RE.search(norm)
    if not m:
        return None
    a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
    if 1 <= a <= 10 and 1 <= b <= 10:
        return a, op, b
    return None


def _compute(a, op, b):
    if op == '+':
        return a + b
    if op == '-':
        return a - b
    if op == '×':
        return a * b
    if op == '÷':
        if b == 0:
            return None
        v = a / b
        if abs(v - round(v)) < 1e-9:
            return int(round(v))
        return round(v, 2)
    return None


def _fmt_answer(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


# --------------------------------------------------------------------------
# ddddocr / RapidOCR 候选收集
# --------------------------------------------------------------------------

def _ddddocr_candidates(gray, charset=None, stop_fn=None):
    """ddddocr 双模型 × 各预处理变体，返回候选列表。

    每项: dict(text, engine, variant, conf)
    stop_fn(result) 返回 True 时提前停止（高置信命中时省时间）。
    """
    results = []
    for tag, old in (('new', False), ('old', True)):
        ocr = _get_ddddocr(old)
        if ocr is None:
            continue
        if charset:
            try:
                ocr.set_ranges(charset)
            except Exception:  # noqa: BLE001
                pass
        try:
            for name, var in _preprocess_variants(gray):
                try:
                    prob = ocr.classification(
                        _to_png_bytes(var), probability=True)
                except Exception:  # noqa: BLE001
                    continue
                if isinstance(prob, dict):
                    text = prob.get('text') or ''
                    conf = float(prob.get('confidence') or 0)
                else:
                    text = prob or ''
                    conf = 0.5
                text = (text or '').strip()
                if text:
                    item = {
                        'text': text,
                        'engine': 'ddddocr-%s' % tag,
                        'variant': name,
                        'conf': conf,
                    }
                    results.append(item)
                    if stop_fn and stop_fn(item):
                        return results
        finally:
            if charset:
                try:
                    ocr.set_ranges(ocr.get_charset())
                except Exception:  # noqa: BLE001
                    pass
    return results


def _rapidocr_candidates(gray):
    """RapidOCR 整行识别候选列表。"""
    ocr = _get_rapidocr()
    if ocr is None:
        return []

    variants = [('raw', gray)]
    for pad in (30, 60):
        for scale in (2, 3):
            p = cv2.copyMakeBorder(gray, pad, pad, pad, pad,
                                   cv2.BORDER_CONSTANT, value=255)
            variants.append(('pad%d_x%d' % (pad, scale),
                             cv2.resize(p, None, fx=scale, fy=scale,
                                        interpolation=cv2.INTER_CUBIC)))
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, thr = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    for name, src in (('thr_pad60_x3', thr), ('inv_pad60_x3', 255 - thr)):
        p = cv2.copyMakeBorder(src, 60, 60, 60, 60,
                               cv2.BORDER_CONSTANT, value=255)
        variants.append((name, cv2.resize(p, None, fx=3, fy=3,
                                          interpolation=cv2.INTER_CUBIC)))

    results = []
    for name, var in variants:
        res, _ = ocr(var)
        if not res:
            continue
        res.sort(key=lambda r: min(p[0] for p in r[0]))
        text = ''.join(t for _, t, s in res)
        if text.strip():
            results.append({'text': text.strip(), 'variant': name})
    return results


# --------------------------------------------------------------------------
# 字形分割
# --------------------------------------------------------------------------

def _segment_glyphs_ex(gray, expected=None):
    """切字（带信息版），返回 (glyphs, forced)。

    forced=True 表示使用了等宽强制切分（字形重叠时的近似切分），
    此时字形块质量较低，调用方应谨慎采信。
    """
    def segment(binary):
        fg = 255 - binary
        H, W = fg.shape
        n, labels, stats, _ = cv2.connectedComponentsWithStats(
            fg, connectivity=8)
        mask = np.zeros_like(fg)
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            # 细长横线（干扰线）：很扁、很宽 → 剔除
            if (h <= 2 and w >= max(12, int(W * 0.35))
                    and w >= h * 5):
                continue
            # 过小的噪点
            if area >= 20 and h >= 8:
                mask[labels == i] = 255
        fg = mask
        colsum = fg.sum(axis=0)
        active = colsum > 0
        runs = []
        i = 0
        while i < len(active):
            if active[i]:
                j = i
                while j < len(active) and active[j]:
                    j += 1
                runs.append([i, j])
                i = j
            else:
                i += 1
        if not runs:
            return [], False
        avg_w = float(np.mean([b - a for a, b in runs]))
        merged = []
        for a, b in runs:
            if merged and a - merged[-1][1] <= max(4, avg_w * 0.30):
                merged[-1][1] = b
            else:
                merged.append([a, b])
        runs = merged
        forced = False

        # 字形重叠导致连成一片时：按期望数把最宽的块近似等宽切分，
        # 切点取邻域(±15%)内列投影最小值
        if expected is not None and len(runs) < expected:
            idx = max(range(len(runs)),
                      key=lambda i: runs[i][1] - runs[i][0])
            a, b = runs[idx]
            width = b - a
            parts = expected - len(runs) + 1
            if parts >= 2 and width >= parts * 4:
                profile = fg[:, a:b].sum(axis=0).astype(float)
                cuts = []
                for i in range(1, parts):
                    ideal = int(width * i / parts)
                    lo = max(0, int(ideal - width * 0.15))
                    hi = min(width, int(ideal + width * 0.15))
                    segm = profile[lo:hi]
                    if len(segm):
                        cut = lo + int(np.argmin(segm))
                    else:
                        cut = ideal
                    cuts.append(a + cut)
                new_runs = []
                prev = a
                for c in cuts:
                    if c - prev >= 1:
                        new_runs.append([prev, c])
                    prev = c
                if b - prev >= 1:
                    new_runs.append([prev, b])
                if len(new_runs) >= 2:
                    runs[idx:idx + 1] = new_runs
                    forced = True

        glyphs = []
        for a, b in runs:
            if b - a < 1:
                continue
            sub = fg[:, a:b]
            rows = np.where(sub.max(axis=1) > 0)[0]
            if len(rows) == 0:
                continue
            y0, y1 = rows[0], rows[-1] + 1
            glyphs.append((a, b, gray[y0:y1, a:b]))
        return glyphs, forced

    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    adapt = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 31, 10)

    cands = []
    for binary in (otsu, adapt):
        g, f = segment(binary)
        if g:
            cands.append((g, f))
    if not cands:
        return [], False

    if expected is not None:
        return min(cands, key=lambda gf: abs(len(gf[0]) - expected))

    def uniformity(glyphs):
        ws = [b - a for a, b, _ in glyphs]
        if not ws:
            return 0.0
        return float(np.std(ws)) / (float(np.mean(ws)) + 1e-6)

    return min(cands, key=lambda gf: uniformity(gf[0]))


def _segment_glyphs(gray, expected=None):
    """切字，返回 [(x0, x1, glyph_img), ...]（按 x 排序）。"""
    return _segment_glyphs_ex(gray, expected)[0]


# --------------------------------------------------------------------------
# 字形级分类
# --------------------------------------------------------------------------

_FONTS = [
    r'C:\Windows\Fonts\arial.ttf', r'C:\Windows\Fonts\arialbd.ttf',
    r'C:\Windows\Fonts\tahoma.ttf', r'C:\Windows\Fonts\tahomabd.ttf',
    r'C:\Windows\Fonts\segoeui.ttf', r'C:\Windows\Fonts\segoeuib.ttf',
    r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\simsun.ttc',
    r'C:\Windows\Fonts\verdana.ttf', r'C:\Windows\Fonts\verdanab.ttf',
    r'C:\Windows\Fonts\times.ttf', r'C:\Windows\Fonts\timesbd.ttf',
    r'C:\Windows\Fonts\consola.ttf', r'C:\Windows\Fonts\consolab.ttf',
    r'C:\Windows\Fonts\calibri.ttf', r'C:\Windows\Fonts\calibrib.ttf',
    r'C:\Windows\Fonts\impact.ttf',
]

_OP_CHARS = '+-×÷'

_template_cache = {}


def _render_char(ch, font_path, size):
    key = (ch, font_path, size)
    cached = _template_cache.get(key)
    if cached is not None:
        return cached
    from PIL import ImageDraw, ImageFont
    try:
        font = ImageFont.truetype(font_path, size)
    except Exception:  # noqa: BLE001
        return None
    canvas = Image.new('L', (size * 2, size * 2), 255)
    d = ImageDraw.Draw(canvas)
    bbox = d.textbbox((0, 0), ch, font=font)
    x = (canvas.width - (bbox[2] - bbox[0])) // 2 - bbox[0]
    y = (canvas.height - (bbox[3] - bbox[1])) // 2 - bbox[1]
    d.text((x, y), ch, font=font, fill=0)
    a = np.array(canvas)
    ys, xs = np.where(a < 240)
    if len(ys) == 0:
        return None
    a = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    if len(_template_cache) < 4000:
        _template_cache[key] = a
    return a


def _gray_corr(glyph, cand):
    gh, gw = glyph.shape
    ch, cw = cand.shape
    if ch == 0 or cw == 0:
        return 0.0
    scale = min(gh / ch, gw / cw)
    nh, nw = max(1, int(ch * scale)), max(1, int(cw * scale))
    cand = cv2.resize(cand, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.full((gh, gw), 255, np.uint8)
    y0, x0 = (gh - nh) // 2, (gw - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = cand
    gz = (glyph.astype(np.float32) - glyph.mean()) / (glyph.std() + 1e-6)
    cz = (canvas.astype(np.float32) - canvas.mean()) / (canvas.std() + 1e-6)
    return float((gz * cz).mean())


def _hole_count(binary):
    bg = cv2.bitwise_not(binary)
    n, labels = cv2.connectedComponents(bg, connectivity=8)
    border = (set(labels[0, :].tolist()) | set(labels[-1, :].tolist())
              | set(labels[:, 0].tolist()) | set(labels[:, -1].tolist()))
    return sum(1 for lab in range(1, n) if lab not in border)


def _template_votes(glyph, chars):
    """字体模板匹配：[(char, score), ...]。"""
    gh, gw = glyph.shape
    binary = (glyph <= 160).astype(np.uint8) * 255
    holes = _hole_count(binary)
    best = []
    for ch in chars:
        for fp in _FONTS:
            for size in range(max(18, gh - 6), gh + 10, 2):
                cand = _render_char(ch, fp, size)
                if cand is None:
                    continue
                sc = _gray_corr(glyph, cand)
                if ch in '0689' and holes >= 1:
                    sc += 0.10
                if ch == '8' and holes >= 2:
                    sc += 0.10
                if ch not in '0689' and holes == 0:
                    sc += 0.03
                best.append((sc, ch))
    return best


def _glyph_ddddocr_vote(glyph, charset, weight=2.0):
    """ddddocr 单字形识别：返回 {char: score}。"""
    votes = {}
    pad = cv2.copyMakeBorder(glyph, 12, 12, 12, 12,
                             cv2.BORDER_CONSTANT, value=255)
    for tag, old in (('new', False), ('old', True)):
        ocr = _get_ddddocr(old)
        if ocr is None:
            continue
        try:
            ocr.set_ranges(charset)
            for k in (2, 3):
                up = cv2.resize(pad, None, fx=k, fy=k,
                                interpolation=cv2.INTER_CUBIC)
                try:
                    prob = ocr.classification(
                        _to_png_bytes(up), probability=True)
                except Exception:  # noqa: BLE001
                    continue
                if isinstance(prob, dict):
                    text = (prob.get('text') or '').strip()
                    conf = float(prob.get('confidence') or 0)
                else:
                    text = (prob or '').strip()
                    conf = 0.5
                if len(text) == 1 and text in charset:
                    votes[text] = votes.get(text, 0.0) + weight * (0.5 + conf)
        finally:
            try:
                ocr.set_ranges(ocr.get_charset())
            except Exception:  # noqa: BLE001
                pass
    return votes


def _glyph_rapid_vote(glyph, charset, weight=1.5):
    rapid = _get_rapidocr()
    if rapid is None:
        return {}
    pad = cv2.copyMakeBorder(glyph, 8, 8, 8, 8,
                             cv2.BORDER_CONSTANT, value=0)
    up = cv2.resize(pad, None, fx=6, fy=6, interpolation=cv2.INTER_CUBIC)
    res, _ = rapid(up)
    votes = {}
    if res:
        for _, t, s in res:
            t = _normalize(t)
            if t in charset:
                votes[t] = votes.get(t, 0.0) + weight * float(s)
    return votes


def _classify_glyph_digit(glyph):
    """单数字字形分类：三方投票，返回 (char, conf) 或 (None, 0)。"""
    votes = {}
    for sc, ch in _template_votes(glyph, DIGIT_CHARSET):
        if sc >= 0.22:
            votes[ch] = votes.get(ch, 0.0) + sc
    for ch, sc in _glyph_ddddocr_vote(glyph, DIGIT_CHARSET).items():
        votes[ch] = votes.get(ch, 0.0) + sc
    for ch, sc in _glyph_rapid_vote(glyph, DIGIT_CHARSET).items():
        votes[ch] = votes.get(ch, 0.0) + sc
    if not votes:
        return None, 0.0
    best = max(votes.items(), key=lambda kv: kv[1])
    total = sum(votes.values()) + 1e-6
    return best[0], best[1] / total


def _detect_div_line(gray):
    """整图级 ÷ 结构检测：孤立点对 + 点对之间的横向笔画。

    规则（严格，避免误报）：
      1. 找到两个“孤立”的小点块（自身成连通域、面积/尺寸受限）；
      2. 两点水平方向基本对齐（dx 小）、垂直距离适中（dy）；
      3. 两点之间的行里存在一条覆盖两点 x 中心的横向笔画；
      4. 点对位于行宽的中部 60%（运算符夹在两个操作数之间）。
    """
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, thr = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    fg = 255 - thr
    H, W = fg.shape
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if n <= 1:
        return False

    dots = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if (4 <= area <= 40
                and w <= max(5, int(W * 0.10))
                and h <= max(5, int(H * 0.15))):
            dots.append((x, y, w, h))

    if len(dots) < 2:
        return False

    for i in range(len(dots)):
        for j in range(i + 1, len(dots)):
            x1, y1, w1, h1 = dots[i]
            x2, y2, w2, h2 = dots[j]
            cx1, cx2 = x1 + w1 / 2.0, x2 + w2 / 2.0
            cy1, cy2 = y1 + h1 / 2.0, y2 + h2 / 2.0
            dx = abs(cx1 - cx2)
            dy = abs(cy1 - cy2)
            if dx > max(5, int(W * 0.08)):
                continue
            if not (5 <= dy <= int(H * 0.6)):
                continue
            cx = (cx1 + cx2) / 2.0
            # 点对需位于行宽中部 60%
            if not (W * 0.2 <= cx <= W * 0.8):
                continue
            # 两点之间必须有覆盖 cx 的横向笔画（长度 ≥ 4）
            y_lo = int(min(y1 + h1, y2 + h2))
            y_hi = int(max(y1, y2))
            bar_found = False
            for r in range(y_lo, y_hi):
                row = fg[r, :]
                if not row.any():
                    continue
                runs = []
                k = 0
                while k < W:
                    if row[k]:
                        k2 = k
                        while k2 < W and row[k2]:
                            k2 += 1
                        runs.append((k, k2))
                        k = k2
                    else:
                        k += 1
                for (s, e) in runs:
                    if s <= cx <= e and (e - s) >= 4:
                        bar_found = True
                        break
                if bar_found:
                    break
            if bar_found:
                return True
    return False


def _operator_heuristics(glyph):
    """运算符结构特征：返回 {char: score}。

    - : 单个横向长条（高 << 宽）
    + : 横竖笔画在中部交叉
    × : 两条对角笔画（对角方向质量占比高）
    ÷ : 横向长条 + 上下两个小点
    """
    gh, gw = glyph.shape
    blur = cv2.GaussianBlur(glyph, (3, 3), 0)
    _, thr = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    fg = 255 - thr
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area >= 6:
            comps.append((x, y, w, h, area))
    if not comps:
        return {}

    rows = np.where(fg.sum(axis=1) > 0)[0]
    cols = np.where(fg.sum(axis=0) > 0)[0]
    if len(rows) == 0:
        return {}
    y0, y1 = rows[0], rows[-1] + 1
    x0, x1 = cols[0], cols[-1] + 1
    bw, bh = x1 - x0, y1 - y0

    big = max(comps, key=lambda c: c[4])

    votes = {}

    def flat_bar(c):
        return (c[2] >= c[3] * 2.0
                and c[3] <= max(8, bh * 0.5)
                and c[2] >= bw * 0.4)

    # '-' : 单个宽扁条
    if len(comps) == 1 and flat_bar(big):
        votes['-'] = votes.get('-', 0.0) + 1.0

    # '+' : 中部有贯穿的横线与竖线
    if len(comps) == 1:
        mid_row = fg[gh // 2, :]
        mid_col = fg[:, gw // 2]
        h_span = float(mid_row.sum()) / 255.0
        v_span = float(mid_col.sum()) / 255.0
        if h_span >= bw * 0.55 and v_span >= bh * 0.55:
            votes['+'] = votes.get('+', 0.0) + 1.2

    # '×' : 对角方向质量
    diag_mask = np.zeros_like(fg)
    cv2.line(diag_mask, (0, 0), (gw - 1, gh - 1), 255, 2)
    cv2.line(diag_mask, (gw - 1, 0), (0, gh - 1), 255, 2)
    diag_mass = float((fg & diag_mask).sum()) / 255.0
    total_mass = float(fg.sum()) / 255.0
    if total_mass > 0 and diag_mass / total_mass > 0.35:
        votes['×'] = votes.get('×', 0.0) + 1.0

    # '÷' : 横向条 + 上下两个点
    bar_comp = None
    for c in comps:
        if flat_bar(c):
            bar_comp = c
            break
    if bar_comp is not None:
        dots = [c for c in comps if c is not bar_comp
                and c[2] <= max(4, bw * 0.25)
                and c[3] <= max(4, bh * 0.25)]
        above = [d for d in dots if d[1] + d[3] < bar_comp[1]]
        below = [d for d in dots if d[1] > bar_comp[1] + bar_comp[3]]
        if above and below:
            votes['÷'] = votes.get('÷', 0.0) + 1.4
        elif dots:
            votes['÷'] = votes.get('÷', 0.0) + 0.6

    return votes


def _classify_glyph_operator(glyph):
    """运算符分类：结构特征 + 模板 + ddddocr + RapidOCR 投票。"""
    votes = {}
    for ch, sc in _operator_heuristics(glyph).items():
        votes[ch] = votes.get(ch, 0.0) + sc * 2.0
    for sc, ch in _template_votes(glyph, _OP_CHARS):
        if sc >= 0.20:
            votes[ch] = votes.get(ch, 0.0) + sc
    for ch, sc in _glyph_ddddocr_vote(glyph, _OP_CHARS).items():
        votes[ch] = votes.get(ch, 0.0) + sc
    for ch, sc in _glyph_rapid_vote(glyph, _OP_CHARS).items():
        votes[ch] = votes.get(ch, 0.0) + sc
    if not votes:
        return None, 0.0
    best = max(votes.items(), key=lambda kv: kv[1])
    total = sum(votes.values()) + 1e-6
    return best[0], best[1] / total


# --------------------------------------------------------------------------
# 逐字形求解
# --------------------------------------------------------------------------

def _glyph_digit_solve(gray, expected_len):
    """切字后逐字形识别，返回 (digits, conf) 或 (None, 0)。"""
    glyphs = _segment_glyphs(gray, expected=expected_len)
    if len(glyphs) != expected_len:
        return None, 0.0
    chars = []
    confs = []
    for _, _, gph in glyphs:
        ch, conf = _classify_glyph_digit(gph)
        if ch is None:
            return None, 0.0
        chars.append(ch)
        confs.append(conf)
    return ''.join(chars), float(np.mean(confs))


def _glyph_math_solve(gray):
    """切字后按 [数字, 运算符, 数字(=?)] 求解。

    返回 (answer, expr, conf) 或 (None, None, 0)。
    低置信时不返回，避免用坏切口上的误判填错答案。
    """
    glyphs = _segment_glyphs(gray, expected=3)
    if len(glyphs) < 3:
        return None, None, 0.0
    a_ch, a_conf = _classify_glyph_digit(glyphs[0][2])
    op_ch, op_conf = _classify_glyph_operator(glyphs[1][2])
    b_ch, b_conf = _classify_glyph_digit(glyphs[2][2])
    if a_ch is None or op_ch is None or b_ch is None:
        return None, None, 0.0
    # ÷ 结构检测具有最高可信度：命中则强制 ÷
    if op_ch != '÷' and _detect_div_line(gray):
        op_ch = '÷'
        op_conf = 0.9
    a, b = int(a_ch), int(b_ch)
    if not (1 <= a <= 10 and 1 <= b <= 10):
        return None, None, 0.0
    if op_conf < 0.65 or min(a_conf, b_conf) < 0.30:
        return None, None, 0.0
    v = _compute(a, op_ch, b)
    if v is None:
        return None, None, 0.0
    conf = float(np.mean([a_conf, op_conf, b_conf]))
    return _fmt_answer(v), '%d%s%d' % (a, op_ch, b), conf


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------

def solve_math_captcha(img):
    """
    算术验证码求解：识别图片中的加减乘除算式并返回结果。
    返回 dict: answer / expression / method / confidence /
               agreement / candidates / raw_text
    """
    gray = _load_image(img)

    votes = {}   # (a, op, b) -> (weight, meta)
    raws = []

    def _vote(text, engine, variant, weight):
        raws.append(text)
        parsed = _parse_expression(text)
        if not parsed:
            return False
        key = parsed
        cur = votes.get(key)
        if cur is None:
            votes[key] = (weight, {'engine': engine, 'variant': variant})
        else:
            votes[key] = (cur[0] + weight * 0.2, cur[1])
        return True

    # 1) ddddocr 无字符集限制（先看原始输出，保留运算符信息）
    #    高置信命中或已有 2 个一致解析时提前停止
    for r in _ddddocr_candidates(gray, charset=None,
                                 stop_fn=lambda r: bool(
                                     votes and r['conf'] >= 0.9)):
        _vote(r['text'], r['engine'], r['variant'],
              3.0 * (0.5 + r['conf']))
        if len(votes) >= 2:
            break

    # 2) ddddocr 限定数学字符集（滤掉 目/日/E 等干扰字符）
    if not votes:
        for r in _ddddocr_candidates(gray, charset=MATH_CHARSET):
            _vote(r['text'], r['engine'], r['variant'],
                  2.5 * (0.5 + r['conf']))
            if votes:
                break

    # 3) RapidOCR 整行
    if not votes:
        for r in _rapidocr_candidates(gray):
            _vote(r['text'], 'rapidocr', r['variant'], 2.0)

    if votes:
        best = max(votes.items(), key=lambda kv: kv[1][0])
        (a, op, b), (weight, meta) = best
        agreement = len(votes)

        # 单候选时做字形级运算符校验：
        # ÷ 常被整行 OCR 误读为 ×/4，- 常被误读为 >/3。
        # 仅在“自然切分”（无强制切块）且置信度高时才否决整行结果，
        # 避免用低质量字形块上的判断推翻识别。
        if agreement <= 1:
            glyphs, forced = _segment_glyphs_ex(gray, expected=3)
            if (not forced and len(glyphs) >= 3):
                op_ch, op_conf = _classify_glyph_operator(glyphs[1][2])
                if (op_ch is not None and op_ch != op
                        and op_conf >= 0.60):
                    v2 = _compute(a, op_ch, b)
                    if v2 is not None:
                        op = op_ch
                        meta = {'engine': 'glyph-veto',
                                'variant': 'operator'}

        # ÷ 结构检测（横杠+两点）优先于一切整行识别的 ×/- 结论
        if op in ('×', '-') and _detect_div_line(gray):
            v2 = _compute(a, '÷', b)
            if v2 is not None:
                op = '÷'
                meta = {'engine': 'div-line',
                        'variant': 'structure'}

        v = _compute(a, op, b)
        total_w = sum(w for w, _ in votes.values())
        return {
            'answer': _fmt_answer(v),
            'expression': '%d%s%d' % (a, op, b),
            'method': '%s(%s)' % (meta['engine'], meta['variant']),
            'confidence': min(0.99, weight / max(total_w, 1e-6)),
            'agreement': agreement,
            'candidates': [
                {'expression': '%d%s%d' % (pa, po, pb)}
                for (pa, po, pb) in votes
            ],
            'raw_text': raws[0] if raws else None,
        }

    # 4) 字形级兜底（重点解决 ÷ 误读、干扰线等；低置信不返回）
    gr = _glyph_math_solve(gray)
    if gr and gr[0]:
        ans, expr, conf = gr
        return {
            'answer': ans, 'expression': expr,
            'method': 'glyphs', 'confidence': conf,
            'agreement': 0,
            'candidates': [], 'raw_text': None,
        }

    return {'answer': None, 'expression': None, 'method': None,
            'confidence': 0.0, 'agreement': 0,
            'candidates': [], 'raw_text': None}


def solve_digit_captcha(img, expected_len=5):
    """
    数字验证码求解：识别图片中的数字串（默认 5 位）。
    返回 dict: digits / method / confidence / agreement /
               candidates / raw_text
    """
    gray = _load_image(img)

    def _clean(text):
        return re.sub(r'[^0-9]', '', text or '')

    exact = []      # 精确位数的候选 (digits, meta, weight)
    approx = []     # 其他候选

    def _stop(r):
        d = _clean(r['text'])
        return len(d) == expected_len and r['conf'] >= 0.9

    # 1) ddddocr 限定数字字符集（双模型 × 多变体）
    for r in _ddddocr_candidates(gray, charset=DIGIT_CHARSET,
                                 stop_fn=_stop):
        digits = _clean(r['text'])
        if not digits:
            continue
        w = 3.0 * (0.5 + r['conf'])
        meta = {'engine': r['engine'], 'variant': r['variant'],
                'conf': r['conf']}
        if len(digits) == expected_len:
            exact.append((digits, meta, w))
        else:
            approx.append((digits, meta, w))

    # 2) RapidOCR 整行
    for r in _rapidocr_candidates(gray):
        digits = _clean(r['text'])
        if not digits:
            continue
        meta = {'engine': 'rapidocr', 'variant': r['variant'], 'conf': 0.5}
        if len(digits) == expected_len:
            exact.append((digits, meta, 2.0))
        else:
            approx.append((digits, meta, 2.0))

    def _finish(digits, meta, conf, agreement):
        return {
            'digits': digits,
            'method': '%s(%s)' % (meta['engine'], meta['variant']),
            'confidence': min(0.99, conf),
            'agreement': agreement,
            'candidates': sorted(
                {d for d, _, _ in exact},
                key=lambda d: -sum(w for dd, _, w in exact if dd == d))[:5],
            'raw_text': None,
        }

    # 3) 精确位数 + 足够支持 → 直接返回
    if exact:
        by_str = {}
        for digits, meta, w in exact:
            by_str.setdefault(digits, []).append((meta, w))
        best_str = max(by_str.items(),
                       key=lambda kv: sum(w for _, w in kv[1]))
        digits, items = best_str
        total_w = sum(w for _, w in items)
        meta = max(items, key=lambda it: it[1])[0]
        support = len(items)
        conf = min(0.99, total_w / (sum(w for _, _, w in exact) + 1e-6))
        if support >= 2 or meta['conf'] >= 0.9 or conf >= 0.55:
            return _finish(digits, meta, conf, support)

    # 4) 字形级兜底
    gd, gconf = _glyph_digit_solve(gray, expected_len)
    if gd:
        return {
            'digits': gd,
            'method': 'glyphs',
            'confidence': gconf,
            'agreement': 1,
            'candidates': [],
            'raw_text': None,
        }

    # 5) 精确位数候选里按加权挑一个（低置信也要给，脚本侧会重试校验）
    if exact:
        by_str = {}
        for digits, meta, w in exact:
            by_str.setdefault(digits, []).append((meta, w))
        best_str = max(by_str.items(),
                       key=lambda kv: sum(w for _, w in kv[1]))
        digits, items = best_str
        meta = max(items, key=lambda it: it[1])[0]
        return _finish(digits, meta,
                       sum(w for _, w in items) /
                       (sum(w for _, _, w in exact) + 1e-6),
                       len(items))

    return {'digits': None, 'method': None, 'confidence': 0.0,
            'agreement': 0, 'candidates': [], 'raw_text': None}


def auto_solve(img, prefer='math', expected_len=5):
    """自动判断拦截类型并求解。"""
    if prefer == 'digit':
        r = solve_digit_captcha(img, expected_len)
        if r['digits'] is not None:
            return {'type': 'digit', **r}
        r2 = solve_math_captcha(img)
        if r2['answer'] is not None:
            return {'type': 'math', **r2}
        return {'type': None, **r}
    r = solve_math_captcha(img)
    if r['answer'] is not None:
        # 字形兜底出的算式结论可靠性较低：
        # 若数字码路径能给出精确位数的结果（5位数字码图被误判为算式时），
        # 优先采信数字码
        if str(r['method'] or '').startswith('glyphs'):
            r2 = solve_digit_captcha(img, expected_len)
            if r2['digits'] is not None:
                return {'type': 'digit', **r2}
        return {'type': 'math', **r}
    r2 = solve_digit_captcha(img, expected_len)
    if r2['digits'] is not None:
        return {'type': 'digit', **r2}
    return {'type': None, **r}


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser(description='自动验证码识别模块自测')
    ap.add_argument('image', help='验证码图片路径')
    ap.add_argument('--type', choices=['math', 'digit', 'auto'], default='auto',
                    help='拦截类型（默认自动判断）')
    ap.add_argument('--len', type=int, default=5, help='数字验证码位数（默认5）')
    args = ap.parse_args()

    if args.type == 'math':
        print(solve_math_captcha(args.image))
    elif args.type == 'digit':
        print(solve_digit_captcha(args.image, args.len))
    else:
        print(auto_solve(args.image, expected_len=args.len))
