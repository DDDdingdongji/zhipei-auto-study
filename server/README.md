# 本地验证码识别服务

配合油猴脚本使用的离线 OCR 服务，识别两类验证码：

| 类型 | 内容 | 返回 |
|---|---|---|
| 数字验证码 | 5 位数字图片 | 数字串，如 `42283` |
| 算式验证码 | 1~10 的加减乘除（如 `2×5`） | 计算结果，如 `10` |

## 两种运行方式

### 方式一：免安装版（推荐，无需 Python）

1. 到 [Releases](../../releases) 下载最新 `captcha-ocr-server-win64.zip`；
2. 解压后双击 `启动识别服务.exe`；
3. 看到 `验证码识别服务已启动: http://127.0.0.1:8765/solve` 即成功，
   刷课期间保持窗口开启。

> 首次运行 Windows SmartScreen 可能提示「已保护你的电脑」，
> 点「更多信息 → 仍要运行」即可（未签名的自打包程序都会这样）。

### 方式二：Python 源码运行

1. 安装 Python 3.8+（安装时勾选 Add to PATH）；
2. 安装依赖：

   ```bat
   cd server
   pip install -r requirements.txt
   ```

   （国内网络慢可加镜像：`pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`）

3. 双击 `启动识别服务.bat`（或 `python captcha_server.py`）。

## 接口

```
GET  /health     健康检查
POST /solve      识别验证码
     请求 JSON: {"image": "<base64 或 dataURL>"}
               或  {"url": "https://.../captcha.png"}
               可选 "type": "auto" | "math" | "digit"
               可选 "expected_len": 5
     响应 JSON: {"ok": true, "type": "digit", "digits": "42283",
                 "method": "ddddocr-new(inv)", "confidence": 0.46,
                 "agreement": 3, "candidates": [...]}
```

## 识别原理（auto_captcha.py）

1. **ddddocr 双模型投票**：新版 + 旧版模型 × 9 种预处理变体
   （原图/放大/反色/Otsu/自适应/CLAHE/中值去噪），
   数字码强制限定字符集 0-9、算式码限定数字+运算符；
2. **RapidOCR（PP-OCRv4）**：整行识别，白边放大多变体；
3. **字形兜底**：投影切字（剔除干扰线、粘连字形等宽切分）→
   逐字形 ddddocr/RapidOCR/字体模板三方投票；
   算式额外有 ÷ 结构检测（解决 ÷ 被误读成 ×/4/-）。

原则：**宁可不答，不答错**——识别失败返回 `ok:false`，
脚本会自动「换一张」重试。

## 日志与排查

服务的每次识别都会打印一行：

```
[OCR] {"ok": true, "type": "math", "answer": "10", "expression": "2×5", "method": "ddddocr-new(raw)", ...}
```

识别出错时把这一行和验证码图片发到 Issues 即可。
