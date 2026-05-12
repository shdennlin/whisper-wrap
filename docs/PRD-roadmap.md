# whisper-wrap v2 — PRD / Roadmap

> 文件型態：**PRD (Product Requirements Document)**
> 涵蓋多個 Spectra change proposals 的整體方向。實作時拆分為各別 `openspec/changes/` 提案。
> 最後更新：2026-05-12

---

## 1. 摘要 (TL;DR)

把 whisper-wrap 從「FastAPI + whisper.cpp 子進程 + 一槍式 GGML 模型」演進為：

1. **單一後端**：用 `faster-whisper` (CTranslate2) 取代 `whisper.cpp` + `whisper-server` 子進程
2. **加 streaming endpoint**：WebSocket `/transcribe-stream`，提供 partial transcript（500–800ms 偽 streaming）
3. **加語音 Q&A endpoint**：`/ask` 串 Google Gemini 2.5 Flash free tier
4. **極簡 PWA 前端**：解決 iOS Shortcut UX 痛點（看不到送出狀態、沒即時字幕、全螢幕錄音介面）
5. **多版本 Breeze-ASR-25 模型轉換並上傳 HuggingFace**：給 GGML + CT2 生態雙線使用者
6. **雙部署目標**：Mac mini 與 PVE + RTX 3070 Ti（同一份 model、同一份 code）

---

## 2. 背景與動機

### 2.1 現況

- 本機 Mac 桌面端用 **VoiceInk** 做 ASR，已導入 Breeze-ASR-25 GGML q8_0（效果很好）
- Server 端 (`whisper-wrap`) 用 `whisper.cpp` + `whisper-server` 子進程，跑 large-v3-turbo / Breeze GGML
- iPhone 透過 Apple Shortcut 打 `/transcribe-raw` endpoint

### 2.2 問題

| 問題 | 影響 |
|---|---|
| Shortcut 無法看到「送出」狀態 | 不確定錄音是否成功上傳 |
| Shortcut 錄音介面全螢幕 modal | UX 壓迫 |
| 沒 streaming，看不到即時字幕 | 邊講邊修錯的能力為零 |
| `whisper.cpp` 子進程 + submodule + 編譯 | Docker build 10–15 分鐘、維護成本高 |
| 要加 streaming 必須再導入 CT2 → 兩套 backend 並存 | 違反 DRY |
| 即將有兩台部署（Mac mini + 3070 Ti），格式策略要先想好 | 不能臨時決定 |

### 2.3 目標

1. **架構統一**：單一 CT2/faster-whisper backend，cover 一槍式 + streaming
2. **UX 升級**：PWA 主介面 + Shortcut 快速通道並存
3. **能力擴張**：從「STT 服務」升級為「個人語音 Q&A」
4. **可移植**：Mac mini 和 GPU server 用同一份 model + code
5. **回饋社群**：Breeze-ASR-25 多格式上 HF

### 2.4 非目標 (Non-Goals)

- ❌ Native iOS App（贏不過 Siri，ROI 低）
- ❌ 完整 personal assistant（記憶、tools、RAG — 撞 Home Assistant 那條線，深坑）
- ❌ 追求 sub-200ms 真 streaming（500–800ms 偽 streaming 已夠 use case）
- ❌ 上 App Store / 商業化
- ❌ Wake word / always-on 喚醒（iOS 系統限制，做不到）

---

## 3. 高層架構決策

### 3.1 最終架構

```
┌──────────────────────────────────────────────────────────┐
│  Client                                                   │
│  ├─ iPhone Shortcut  (action button / hotkey)            │
│  ├─ PWA (added to home screen)                           │
│  ├─ Mac VoiceInk (GGML, 本機跑)                          │
│  └─ curl / web                                            │
└─────────────────────┬────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  whisper-wrap (FastAPI, single process)                  │
│                                                           │
│  POST /transcribe   — 音檔 → 文字 (multipart OR raw)      │
│  WS   /listen       — 串流 audio → 串流 partial transcript│
│  POST /ask          — audio/text → answer (?stream=true) │
│  GET  /status       — 狀態 + model info                  │
│  GET  /             — API discovery                       │
│                                                           │
│  Backend: faster-whisper + Breeze-ASR-25 (CT2, int8_fp16)│
│  Streaming layer: whisper-streaming (sliding window+VAD) │
│  LLM proxy: google-genai SDK (Gemini 2.5 Flash)          │
└──────────────────────────────────────────────────────────┘
```

### 3.2 移除

- `whisper.cpp` git submodule
- `whisper-server` 子進程（port 9000）
- `app/services/whisper.py` 的 HTTP client
- Dockerfile 裡的 whisper.cpp 編譯步驟
- Makefile 的 `setup-submodule`、`build-whisper`、`run-whisper` targets
- `.env` 的 `WHISPER_SERVER_HOST` / `WHISPER_SERVER_PORT` / `WHISPER_SERVER_URL`

### 3.3 新增

- `faster-whisper` 依賴
- `whisper-streaming` 依賴（或內嵌簡化版）
- `google-genai` 依賴
- WebSocket + SSE 支援
- 新 endpoint：`/listen` (WS)、`/ask` (POST，含 SSE 模式)
- 重命名 endpoint：`/transcribe-stream` → `/listen`、`/health` → `/status`
- 合併 endpoint：`/transcribe-raw` 併入 `/transcribe`（Content-Type 區分）
- 新 env vars：`GEMINI_API_KEY`、`MODEL_DIR`（取代 `MODEL_PATH`）
- PWA 目錄：`app/static/pwa/`（HTML + JS 一個檔）

### 3.4 完整 endpoint 規格（v2.0.0）

| Endpoint | Content-Type / Mode | 回應 |
|---|---|---|
| `POST /transcribe` | `multipart/form-data` (file 欄位) | `{"transcript": "..."}` |
| `POST /transcribe` | `audio/*` 或 `application/octet-stream` (raw body) | 同上 |
| `WS /listen` | binary frames：16kHz mono PCM chunks | JSON events: `{type:"partial",text:"..."}` / `{type:"final",text:"..."}` |
| `POST /ask` | `multipart/form-data` (file 欄位) | `{"transcript": "...", "answer": "..."}` |
| `POST /ask` | `audio/*` (raw body) | 同上 |
| `POST /ask` | `application/json` `{"text": "..."}` | `{"transcript": null, "answer": "..."}` |
| `POST /ask?stream=true` | 同上三種輸入 | SSE: `event: transcript` → `event: token` (多次) → `event: done` |
| `GET /status` | — | `{status, model:{name,path,compute_type,device,loaded,load_time_ms}, version, uptime_seconds, gemini:{configured,model}}` |
| `GET /` | — | API discovery (列出所有 endpoint) |

**`/transcribe` 內容協商邏輯**：
```python
if content_type.startswith("multipart/"):
    audio_bytes = (await request.form())["file"].read()
elif content_type.startswith("audio/") or content_type == "application/octet-stream":
    audio_bytes = await request.body()
else:
    raise 415 Unsupported Media Type
```

`/ask` 同理，額外支援 `application/json` 走純文字路徑（跳過 STT）。

---

## 4. 模型轉換策略

### 4.1 來源

- **Base**：`MediaTek-Research/Breeze-ASR-25` (HuggingFace, Whisper-large-v2 fine-tune)
- License：Apache 2.0（衍生格式可上 HF）

### 4.2 完整版本矩陣

> 命名前綴：`shdennlin/breeze-asr-25-<format>` (HF repo)

#### GGML 版本（給 VoiceInk / whisper.cpp 使用者）

| 量化 | 磁碟 | RAM (Core ML) | WER ↑ | 速度 M1 / M2+ | 速度 x86 CPU | 優先度 | 備註 |
|---|---|---|---|---|---|---|---|
| f16 | ~3.0 GB | ~3.8 GB | **基準 0%** | 2–3x / 4–6x | 0.8–1.2x | P1 | 原始品質，研究/比較用 |
| **q8_0** ⭐ | ~800 MB | **~1.4 GB** | **+0.1–0.3%** | **3–5x / 6–9x** | 1.5–2.5x | **P0** | **甜蜜點，準度幾乎無損** |
| q5_K_M | ~550 MB | ~1.0 GB | +0.5–1% | 4–6x / 7–10x | 2–3x | P1 | 中量化，記憶體緊時 |
| q5_0 | ~520 MB | ~1.0 GB | +1–1.5% | 4–6x / 7–10x | 2–3x | P2 | 舊版量化，相容性最廣 |
| q4_K_M | ~450 MB | ~0.85 GB | +1–2% | 5–7x / 8–12x | 2.5–3.5x | P1 | 極省，邊緣裝置 |
| q4_0 | ~420 MB | ~0.8 GB | +2–3% | 5–7x / 8–12x | 2.5–3.5x | P2 | 舊版極省 |

**Core ML encoder（搭配 GGML 使用，Apple Silicon ANE 加速）**

| 檔案 | 大小 | RAM 額外 | 速度提升（vs 同量化 GGML 純 CPU）| WER 影響 | 優先度 |
|---|---|---|---|---|---|
| `ggml-breeze-asr-25-encoder.mlmodelc` | ~150 MB | +200 MB peak load | **encoder 3–5x、端到端 1.3–2x** | **0%** | P2 |

**搭配說明**：
- **不是獨立模型，是 whisper.cpp 的 encoder 加速器**
- 跟任何 GGML 量化（q8_0、q5_K_M、q4_K_M…）搭配使用，效果疊加；decoder 仍跑 CPU/Metal
- WER **等同搭配的 GGML 版本**（Core ML 只是換一條執行路徑跑同一份 encoder weights，數值零差異）
- 載入時會「JIT 編譯」幾秒 → 首次啟動稍慢，之後快
- **僅對 whisper.cpp / VoiceInk 有意義；faster-whisper 不吃這格式**

#### Mac mini 上「最佳組合」討論（重要決策）

> 為什麼 PRD 選 faster-whisper 而不是 whisper.cpp + Core ML？這節說清楚。

| 選擇 | encoder 速度 | streaming 支援 | 統一程度 | 適合場景 |
|---|---|---|---|---|
| whisper.cpp + q8_0 + Core ML | **最快**（ANE 加速）| 弱（stream example 玩具版）| Mac 專屬 | **桌面 / VoiceInk 本機** |
| **faster-whisper + CT2 int8_float16** ⭐ | 慢 ~15–25% | 強（whisper-streaming） | **跟 GPU server 一致** | **server 部署（Mac mini + PVE）** |

**結論**：兩個都會用到，但用在不同地方
- **Mac mini 上的 server**（whisper-wrap）→ 走 faster-whisper + CT2，享受統一架構 + streaming
- **Mac 本機桌面 ASR**（VoiceInk）→ 繼續走 GGML q8_0 + Core ML encoder，享受 ANE 極速

也就是說，**Core ML encoder 你還是要轉**，但用在 VoiceInk 那邊，不是 server。HF 上的 Core ML repo 是給 VoiceInk 使用者下載的。

**為什麼 server 不也用 whisper.cpp + Core ML 拿 ANE 加速？**
1. 兩台部署（Mac mini + 3070 Ti GPU）共用一份 model 格式 + 一份程式碼 → 維護成本只剩一半
2. `/listen` streaming 用 whisper-streaming（CT2 後端）成熟很多，whisper.cpp 那邊 stream 還是玩具
3. encoder 那 ~20% 速度差距在你 use case（個人單一請求、不是高並發）幾乎感受不到
4. 哪天真的要 Mac mini 衝最高 perf，可以加 `BACKEND=whisper.cpp` env var 切換，但 v2.0.0 不先做

#### 關於 bfloat16 給 Mac mini？

⚠️ **不要選 bf16 跑 Mac mini 的 faster-whisper**，理由：

| 觀察 | 細節 |
|---|---|
| faster-whisper 在 Mac 上跑 CPU（Accelerate）| 不走 GPU/MPS |
| Apple Silicon 沒有 AVX-512 BF16 指令集 | bf16 在 CPU 上**沒硬體加速** |
| int8_float16 的 INT8 weights cache locality 更好 | CPU 上**比 bf16 快** |
| bf16 主要優勢場景 | 新一代 GPU（Hopper / RTX 50）才有意義 |

→ **Mac mini 仍然推薦 int8_float16**，跟 3070 Ti GPU server 同款。bf16 留給「未來升級 RTX 5090」的場景才考慮。

#### CTranslate2 版本（給 faster-whisper / server 使用者）

| 量化 | 磁碟 | RAM (CPU) | VRAM (GPU) | WER ↑ | 速度 CPU | 速度 3070 Ti | 優先度 | 備註 |
|---|---|---|---|---|---|---|---|---|
| float16 | ~1.5 GB | ~2.8 GB | ~3.1 GB | **基準 0%** | N/A | 25–35x | P1 | GPU 部署（VRAM 充足） |
| **int8_float16** ⭐ | ~800 MB | **~1.8 GB** | **~2.3 GB** | **+0.2–0.5%** | **3–5x** | **20–30x** | **P0** | **server 主推（Mac+GPU 通用）** |
| int8 | ~600 MB | ~1.5 GB | ~1.8 GB | +0.3–0.6% | 3–5x | 15–25x | P1 | 純 CPU server |
| bfloat16 | ~1.5 GB | ~2.8 GB | ~3.1 GB | ~0% | N/A | 25–35x | P2 | Hopper / 新 Mac 可選 |

> **速度單位**：x = real-time multiplier（1 分鐘音檔處理需 60/x 秒）。例如 5x = 1 分鐘音檔花 12 秒
> **數字假設**：beam_size=5、30 秒音檔片段、單一 inference、機器無其他重負載
> **WER ↑** 是相對 fp16 baseline 的**絕對百分點**增加（不是相對 %）。例如 baseline 8% → q5_K_M 約 8.5–9%
> **streaming 額外加** ~150 MB 記憶體
> **process baseline** (Python+FastAPI) 已含在 CT2 RAM 數字裡 (~500 MB)
> **WER 數字**為 Mandarin/multilingual benchmark 上的典型範圍，**台灣華語/中英混雜場景**可能略高（Breeze 微調過，仍承襲 Whisper 量化容忍度）

### 4.2.1 記憶體 / 速度說明

> 各 quantization 的數字已併入 §4.2 主表格。本節只放需要展開說明的補充。

**記憶體公式**（粗估）：
```
runtime_memory ≈ weight_size × 1.2~1.5 + activation_buffer + process_overhead
```
- `activation_buffer`：encoder 跑 30 秒音檔大約 300–600 MB
- `process_overhead`：Python + FastAPI baseline ≈ 150 MB
- streaming 模式再加 ~100–300 MB（連續 inference state + sliding window buffer）

**速度名詞**：
- **RTF (Real-Time Factor)**：跑 1 秒音檔所需的秒數。RTF=0.2 = **5x real-time**（1 分鐘音檔花 12 秒）
- 主表的「速度」欄都是 real-time multiplier
- 數字假設 beam_size=5、30 秒音檔片段、單一 inference

**情境對速度的需求**：

| 情境 | 需要 RTF | 哪些配置滿足 |
|---|---|---|
| 一槍式轉錄（1 分鐘音檔等幾秒）| < 1.0（>1x real-time）| 幾乎全部都滿足 |
| `/listen` 串流即時字幕（partial 延遲 < 1 秒）| < 0.5（>2x）| q8_0 以上全部滿足 |
| 長音檔批次處理（避免等太久）| < 0.2（>5x）| M2 以上 / GPU / q5_K_M↓ |

**3070 Ti GPU 加速差距很大**：M1 上跑 1 小時音檔約 12–20 分鐘；3070 Ti 上 2–3 分鐘。**離線批次轉錄場景優先給 GPU server**。

**兩個常見誤區**：

❌ **誤區一**：「q4_0 比 q8_0 快兩倍」
→ 體積小不等於快兩倍，瓶頸在 encoder forward。速度差距 1.2–1.5x，**但準度掉很有感**。省記憶體有，省時間不多。

❌ **誤區二**：「unified memory 不用算 VRAM」
→ Apple Silicon 整個機器都吃同一塊記憶體。瀏覽器 + IDE + Slack 可以輕鬆佔 4 GB，務必預留。

#### Streaming 延遲分項

`/listen` 的「partial 出現延遲」由幾個部分組成：

| 元件 | 典型延遲 |
|---|---|
| Audio chunk 累積（client 端，250ms chunk） | ~250 ms |
| WebSocket 傳輸 | < 10 ms |
| VAD endpoint detection | ~50–100 ms |
| Whisper inference（M1 q8_0，2 秒視窗）| ~400–600 ms |
| Whisper inference（3070 Ti int8_f16）| ~80–150 ms |
| 回傳 partial event | < 10 ms |
| **總延遲：M1** | **~700 ms–1 s** |
| **總延遲：3070 Ti** | **~400–500 ms** |

→ 你 PRD §2.4 列的「500–800ms 偽 streaming」**M1 偏鬆但勉強做到，3070 Ti 輕鬆達標**。

#### 速度 vs 準度 trade-off 圖（直覺版）

```
準度高 ↑
       │
  f16  ●
       │
  q8_0 ●  ⭐ 甜蜜點
       │
 q5_K_M●
       │
 q4_K_M●
       │
       └────────────────→ 速度快
        慢         q8_0       快
```

**結論**：q8_0 / int8_float16 是「準度幾乎無損 + 速度顯著提升」的甜蜜點。q5 以下只有「記憶體很緊」才考慮。

> ⚠️ 上表都是粗估，實際 RTF 受 beam_size、音檔長度、CPU 散熱、其他程式競爭資源等影響可能差 ±30%。要精準數字請自己 benchmark。

---

### 4.3 推薦轉換批次

**最少（P0 only）**：2 個版本
- GGML q8_0
- CT2 int8_float16

**推薦（P0 + P1）**：7 個版本 ⭐
- GGML: f16, q8_0, q5_K_M, q4_K_M
- CT2: float16, int8_float16, int8

**完整（P0 + P1 + P2）**：11 個版本
- 上表全部，含 Core ML encoder

### 4.4 轉換步驟

#### Step 1：下載原始 model
```bash
huggingface-cli download MediaTek-Research/Breeze-ASR-25 \
  --local-dir ./source/breeze-asr-25
```

#### Step 2：GGML 系列（在 Mac，用 whisper.cpp 工具）
```bash
cd whisper.cpp

# 轉成 fp16 GGML
python models/convert-h5-to-ggml.py \
  ../source/breeze-asr-25 \
  ../source/whisper-pytorch ../output/

# 量化（產出 q8_0, q5_K_M, q4_K_M）
for q in q8_0 q5_K_M q5_0 q4_K_M q4_0; do
  ./build/bin/quantize \
    ../output/ggml-breeze-asr-25-f16.bin \
    ../output/ggml-breeze-asr-25-${q}.bin ${q}
done

# Core ML encoder（可選）
./models/generate-coreml-model.sh breeze-asr-25
```

#### Step 3：CT2 系列（任一機器，用 ctranslate2）
```bash
pip install ctranslate2 transformers[torch]

for q in float16 int8_float16 int8 bfloat16; do
  ct2-transformers-converter \
    --model ./source/breeze-asr-25 \
    --output_dir ./output/breeze-asr-25-ct2-${q} \
    --quantization ${q} \
    --copy_files tokenizer.json preprocessor_config.json
done
```

#### Step 4：上傳 HuggingFace
分成兩個 repo（GGML 慣例和 CT2 慣例不同）：

```bash
# Repo 1: GGML 系列（單一 repo 多檔）
huggingface-cli repo create breeze-asr-25-ggml
huggingface-cli upload shdennlin/breeze-asr-25-ggml \
  ./output/ggml-breeze-asr-25-*.bin

# Repo 2: CT2 系列（每個量化一個 branch 或 subfolder）
huggingface-cli repo create breeze-asr-25-ct2
# 上傳每個 subdir
for q in float16 int8_float16 int8; do
  huggingface-cli upload shdennlin/breeze-asr-25-ct2 \
    ./output/breeze-asr-25-ct2-${q} ${q}
done
```

#### Step 5：寫 model card（README.md）
- 標明 base model（Whisper-large-v2 → Breeze-ASR-25 fine-tune）
- License：Apache 2.0（繼承自上游）
- 強調台灣華語 + 中英 code-switching
- 各版本選擇指南（GGML vs CT2、量化選擇）
- 使用範例（whisper.cpp、VoiceInk、faster-whisper）

---

## 5. 分階段實作計畫

### Phase 0：模型轉換 + HF 上傳（1–2 個晚上）

- [ ] 在 Mac 完成 GGML 系列轉換（q8_0 已有，補 f16/q5_K_M/q4_K_M）
- [ ] 在 Mac 或 PVE 完成 CT2 系列轉換（int8_float16/float16/int8）
- [ ] 建立兩個 HF repo 並上傳
- [ ] 撰寫 model card README
- [ ] （可選）產生 Core ML encoder

**驗收**：HF 上看得到並能下載；whisper.cpp 載 GGML 可推理；faster-whisper 載 CT2 可推理

---

### Phase 1：`/ask` endpoint（一個下午）

**目標**：Shortcut 一鍵變成「語音問答」

- [ ] 加 `google-genai` 依賴
- [ ] 新增 `app/services/llm.py`（Gemini client，支援 streaming + blocking 兩種模式）
- [ ] 新增 `app/api/ask.py`：
  - 支援三種輸入：`multipart` / `audio/*` raw / `application/json {text}`
  - 支援 `?stream=true` 開 SSE 回應
  - 回應格式：`{"transcript": "...", "answer": "..."}`
- [ ] `.env` 加 `GEMINI_API_KEY`、`GEMINI_MODEL`（預設 `gemini-2.5-flash`）、`GEMINI_SYSTEM_PROMPT`（**單一字串設定 system prompt**，預設值放一個合理的台灣助理 persona）
- [ ] 新增 Shortcut 範本：錄音 → POST `/ask` (raw audio) → 顯示答案 / 朗讀
- [ ] 加 tests：mock Gemini response，三種輸入模式 + streaming + blocking 共 6 種組合

**驗收**：iPhone Shortcut 講「2026 年諾貝爾物理獎是誰得的」→ 得到答案；curl POST JSON 也能用；改 `.env` 重啟後 system prompt 生效

---

### Phase 2：後端遷移（whisper.cpp → faster-whisper）+ endpoint 重新洗牌（一個週末）

**目標**：移除 whisper-server 子進程，所有 endpoint 用同一個 CT2 model；同時完成 endpoint 命名收斂

- [ ] 加 `faster-whisper` 依賴
- [ ] 重寫 `app/services/whisper.py`：從 HTTP client 變成 in-process `WhisperModel` wrapper
- [ ] 改 `app/config.py`：`MODEL_DIR` 取代 `WHISPER_SERVER_URL` / `MODEL_PATH`
- [ ] 加 `device="auto"`、`compute_type="int8_float16"` 設定
- [ ] 改 `app/main.py` lifespan：啟動時載入 model 到記憶體
- [ ] **合併 `/transcribe-raw` → `/transcribe`**：寫 Content-Type 分派邏輯（multipart vs raw audio）
- [ ] **`/health` → `/status`**：擴充回應 schema（見 §3.4）
- [ ] 更新 `registry/models.yaml`：改成 CT2 dir 而非 GGML file；**保留 `large-v3-turbo` 作為非台灣華語場景 fallback**（faster-whisper 直接認模型名自動下載 HF CT2 版本，不用自己轉）
- [ ] 改 `Makefile`：移除 `setup-submodule`、`build-whisper`、`run-whisper`
- [ ] 改 `Dockerfile`：移除 whisper.cpp 編譯步驟
- [ ] 移除 `whisper.cpp` submodule（`git submodule deinit` + 改 `.gitmodules`）
- [ ] 更新自己的 iOS Shortcut：URL 從 `/transcribe-raw` 改成 `/transcribe`（headers 不變）
- [ ] 更新 tests
- [ ] 更新 CLAUDE.md 和 README

**驗收**：`make dev` 啟動單一 FastAPI process；`/transcribe` 同時支援 multipart 和 raw audio；`/status` 回完整資訊；Docker build < 5 分鐘

---

### Phase 3：`/listen` (WebSocket streaming)（一個週末）

**目標**：解鎖即時字幕能力

- [ ] 加 `whisper-streaming` 依賴（或內嵌簡化版實作）
- [ ] 新增 `app/api/listen.py`：WebSocket endpoint
- [ ] 設計訊息協定：
  - Client → Server: 16kHz mono PCM chunks (binary frames)
  - Server → Client: `{"type":"partial","text":"...","start_ms":1234,"end_ms":2345}` / `{"type":"final","text":"...","start_ms":...,"end_ms":...}`
  - **partial 和 final 都帶 timestamp**（相對於 stream 開始的毫秒數）
- [ ] VAD endpoint detection（whisper-streaming 內建）
- [ ] 共用 Phase 2 載入的同一個 `WhisperModel` instance
- [ ] 加 tests：mock WebSocket flow

**驗收**：用 `wscat` 或測試腳本送 PCM chunks，能看到 partial transcript 流回；延遲 500–800ms 級

---

### Phase 4：極簡 PWA 前端（一兩個晚上）

**目標**：取代 Shortcut 成為主要介面

- [ ] 新增 `app/static/pwa/index.html`、`app.js`、`manifest.json`、`sw.js`（service worker）
- [ ] UI 元素：
  - 大錄音按鈕（按住說話 / 點擊切換）
  - Partial transcript 區（灰色動態顯示）
  - Final transcript 區（黑色）
  - Gemini 回覆區
  - 清楚的「送出 / 取消」按鈕
  - 連線狀態指示
- [ ] **單問單答模式**：每次 refresh / 「新問題」按鈕清空畫面；**不做 conversation history**（無 localStorage、無多輪 context）
- [ ] 用 Web Audio API + AudioWorklet 取得 16kHz mono PCM
- [ ] 連 `/listen` (WebSocket) 顯示 partial
- [ ] 「Ask」按鈕另外打 `/ask?stream=true` (SSE)，回答逐 token 顯示
- [ ] 加 manifest 支援「加到主畫面」
- [ ] iOS 加 Apple touch icon
- [ ] FastAPI mount `/pwa` 提供靜態檔

**驗收**：iPhone Safari 開 `http://server:8000/pwa`，加到主畫面，按下錄音邊講邊看到字；按 Ask 得到 Gemini 答覆

---

### Phase 5：Shortcut UX 修補（半小時）

**目標**：Shortcut 仍當 fallback / 快速通道時體驗不那麼差

- [ ] 更新 Shortcut 範本：
  - 改 URL：`/transcribe-raw` → `/transcribe`（headers 不變）
  - 新增「Ask」變體：打 `/ask` (raw audio) → 顯示答案
  - `Vibrate Device` (送出前)
  - `Show Notification "已送出"` (POST 後)
  - `Speak` (收到答案後朗讀)
- [ ] **重拍 Shortcut 截圖**：新流程跟舊版差很多（合併 endpoint、加 Ask、加觸覺回饋），更新 `docs/ios-shortcuts-workflow.jpeg`
- [ ] 更新 docs：放新 Shortcut 連結

**驗收**：Shortcut 流程中有清楚的觸覺/視覺回饋；截圖反映 v2.0 endpoint 流程

---

### Phase 6（可選）：雙部署整合

**目標**：Mac mini 和 PVE GPU server 都能跑同一套

- [ ] 確認 `device="auto"` 在 Mac (CPU+Accelerate) 和 Linux+CUDA (3070 Ti) 都正確
- [ ] `compute_type="int8_float16"` 兩邊跑通
- [ ] Docker image 同時支援 ARM64 (Mac) 和 amd64 + CUDA (PVE)
- [ ] 評估是否要 `.env.mac` 和 `.env.gpu` profile

**驗收**：兩台機器都跑 `make dev` 起得來、`/health` 200

---

## 6. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|---|---|---|---|
| Breeze-ASR-25 轉 CT2 失敗（tokenizer 差異） | 低 | 高 | Phase 0 先做 smoke test |
| `whisper-streaming` 對 fine-tuned model 行為不穩 | 中 | 中 | 必要時改套 `WhisperLiveKit`（同樣吃 CT2） |
| PWA 在 iOS Safari 上錄音 quirks | 中 | 中 | 用 Add to Home Screen 模式，避開 Safari tab 限制 |
| Gemini Flash free tier 限流 | 低 | 低 | 加 retry + log；超量回 fallback 訊息 |
| 移除 whisper.cpp 後失去 Apple Silicon Core ML 加速 | 中 | 中 | server 場景不影響；Mac 桌面繼續用 VoiceInk + GGML |
| HF 上傳被誤判 license | 低 | 中 | 嚴格繼承 Apache 2.0，標清楚 base model |
| Phase 2 後 model load 變慢（faster-whisper 啟動需時） | 中 | 低 | lifespan 啟動時 eager load，加 readiness probe |

---

## 7. 開放問題（之後決定即可）

> Q1–Q4 已於 2026-05-12 決議，內容已併入 §5 各 Phase tasks。
> 決議摘要：partial+final 都帶 timestamp / system prompt 走 env var / 保留 large-v3-turbo fallback / PWA 單問單答無 history。

1. **GitHub release 是否要綁 HF model 版本？** 例如 `v2.0.0` 對應特定 CT2 commit（release 流程細節，v2.0 收尾時決定）
2. **何時引入 WhisperKit / 外部 STT backend（v2.1+ escape hatch）？**
   - **不在 v2.0 範圍**。先讓 faster-whisper + CT2 int8_float16 跑跑看
   - **觸發條件**（任一發生就考慮升級）：
     - Mac mini 上 `/listen` partial 延遲 > 1.5 秒持續發生
     - 一槍式轉錄 1 分鐘音檔等超過 20 秒
     - 同時開 Slack / 瀏覽器時 server 明顯卡頓
   - **實作路徑**（~1 個下午）：
     - 抽象 `STTBackend` interface（Phase 2 已經把 STT 邏輯收斂到 `app/services/whisper.py`，從那裡長出來）
     - 新增 `WhisperKitBackend` 走 HTTP proxy 到 user 自己起的 `whisperkit-cli serve`
     - 新 env var：`BACKEND_TYPE=faster_whisper|external` + `BACKEND_URL=http://localhost:5050`
     - Mac mini `.env` 設 external，PVE GPU `.env` 設 faster_whisper
   - **避免做的事**：不要在 whisper-wrap 內 spawn/管理 whisperkit-cli 進程（child process lifecycle 是 v1 的痛，不重蹈覆轍 — 讓 user 用 `brew services` 自管）

---

## 8. 對應 Spectra Change 拆分建議

> 2026-05-12 決議：**拆成 3 個 spec**（原本規劃 6 個過細，個人專案合併更順）

| Spec name | 包含 Phase | 大小 | 平行/依賴 |
|---|---|---|---|
| `publish-breeze-asr-25-models` | 0 | M | **獨立**，純資料工程，可第一個開工或全程平行 |
| `v2-server-redesign` ⭐ 主菜 | 1 + 2 + 3 + 5 | XL | server-side 全包：`/ask` + 後端遷移 + `/listen` + Shortcut 更新 |
| `add-pwa-frontend` | 4 | M | 依賴 `v2-server-redesign` 的 `/listen` + `/ask` 已穩定 |

**為什麼把 Phase 1+2+3+5 綁成主菜**：
- 都動同一批檔案（`app/services/whisper.py`、`config.py`、`main.py`）
- 拆開做會重複修改同個檔案 3 次，PR 互相打架
- Phase 5（Shortcut config）只是 5 分鐘的事，順手做掉

**為什麼 PWA 不一起綁**：
- 前端是新 codebase（HTML/JS），測試循環跟後端不同
- 綁一起會讓主菜 spec 變成「永遠 review 不完的怪物」
- 後端穩定後做 PWA 更省事

**建議執行時程**：
```
Week 1 (平行):
  - publish-breeze-asr-25-models（Mac 上轉檔 + HF 上傳）
  - v2-server-redesign 開工

Week 2:
  - v2-server-redesign 收尾、merge to main

Week 3:
  - add-pwa-frontend（用穩定的 /listen 和 /ask）
```

---

## 9. 成功指標

完成後應滿足：

- ✅ Docker build < 5 分鐘（原本 10–15 分鐘）
- ✅ 程式碼 LOC 減少（移除 whisper.cpp wrapper + 子進程管理）
- ✅ 啟動只有單一 process（FastAPI）
- ✅ iPhone Shortcut 流程不變（向後相容）
- ✅ PWA 可在 iOS Safari 加到主畫面、錄音、看 partial、得到 Gemini 答覆
- ✅ Mac mini 和 PVE GPU server 兩邊都能跑同一份 Docker image
- ✅ Breeze-ASR-25 至少 P0+P1 七個版本上 HF，model card 完整

---

## 10. 詳細清理清單 (Cleanup Scope)

> 這節是 audit-grade 的「會被砍掉什麼」清單。Phase 2（後端遷移）執行時逐項勾選。
> 數字來自實際 codebase 掃描（2026-05-12）。

### 10.1 完全刪除的檔案 / 目錄

| 路徑 | 大小 / 行數 | 原因 |
|---|---|---|
| `whisper.cpp/` (submodule) | **53 MB** | 不再需要編譯，CT2 取代 |
| `app/services/whisper_manager.py` | **188 行** | 整個 whisper-server lifecycle / auto-restart 機制報廢 |
| `app/services/whisper.py` (舊版) | **169 行** | HTTP client 廢；改寫為 ~50 行的 faster-whisper wrapper |
| `.gitmodules` 中的 whisper.cpp entry | 3 行 | 撤掉 submodule reference |
| **`DOCKER_NAMING.md`** | 2.1 KB | 2025-07 歷史 changelog，內容已併入 README/CLAUDE.md（2026-05-12 確認） |
| **`doc/` 目錄**（lowercase）| — | 圖片搬到 `docs/` 後刪除空目錄 + `.DS_Store`（2026-05-12 確認） |
| **`./whisper-wrap` CLI wrapper** | 1.2 KB | 純粹是 Makefile 的別名層，個人專案用 `make` 直接打就好（2026-05-12 確認） |

**Python LOC 變化**：~360 行刪除 → ~50 行新增 = **淨減 ~310 行**

### 10.2 大幅修改的檔案

| 檔案 | 行數 | whisper-server 相關引用 | 修改範圍 |
|---|---|---|---|
| `app/main.py` | 114 | 19 處 | 移除 lifespan 中啟動/監控 whisper-server 的程式碼，改為 lifespan 載入 `WhisperModel` 到記憶體 |
| `app/config.py` | 85 | 14 處 | 移除 `WHISPER_SERVER_*` 所有設定 + port validation 邏輯，新增 `MODEL_DIR`、`GEMINI_API_KEY` |
| `app/api/transcribe.py` | 190 | 2 處 | 改 import，呼叫新 whisper module（介面差不多） |
| `Makefile` | ~280 | 13 處 | 移除 6 個 targets（見 §10.4），`dev` 變成單一 process |
| `Dockerfile` | 112 | 3 處 | 移除 whisper.cpp clone / build stage；build deps 大幅精簡 |
| `registry/models.yaml` | 60+ | 全部 | 改 schema：GGML file → CT2 dir + format 欄位區分（或拆兩個 registry） |
| `.env.example` | 28 | 7 處 | 移除 7 個 env vars（見 §10.3） |
| **`scripts/model-manager.sh`** | 13 KB → ~3–4 KB | 整支重寫 | 改成跑 `huggingface-cli download` 拉 CT2 資料夾；CLI command (`models/download/set/delete`) 介面保持不變（2026-05-12 確認） |
| **`README.md`** image 路徑 | 1 行 | — | `<img src="doc/...">` 改成 `<img src="docs/...">` |

### 10.3 移除的環境變數

從 `.env.example`、`app/config.py`、`docs/`：

- `WHISPER_SERVER_HOST`
- `WHISPER_SERVER_PORT`
- `WHISPER_SERVER_URL`
- `WHISPER_AUTO_RESTART`
- `WHISPER_BINARY_PATH`
- `WHISPER_MAX_RETRIES`
- `MODEL_PATH`（改用 `MODEL_DIR` 指向 CT2 資料夾）

**新增**：
- `GEMINI_API_KEY`
- `GEMINI_MODEL`（預設 `gemini-2.5-flash`）
- `MODEL_DIR`（取代 `MODEL_PATH`，因 CT2 是資料夾不是檔案）
- `COMPUTE_TYPE`（預設 `int8_float16`）
- `DEVICE`（預設 `auto`）

### 10.4 移除的 Makefile targets

- `init-submodule` — 不再需要
- `build-whisper` — 不再需要
- `run-whisper` — 不再需要（沒有 whisper-server process 了）
- `check-system-deps` — **保留但精簡**（移除 cmake/gcc/make 等 whisper.cpp build deps）
- `install-system-deps` — **保留但精簡**（同上）
- `setup` — **保留但精簡**（不再 init submodule / build whisper）
- `clean` — **保留但精簡**（不再清 whisper.cpp build artifacts）

**新增**：
- `convert-model` — Breeze-ASR-25 轉 CT2（可選，模型已上 HF 後其實用 `download-model` 就好）

`dev` target 行為變化：從「同時開兩個 process」變成「單一 FastAPI process」，可大幅精簡。

### 10.5 Dockerfile 變化

**移除**：
- 多階段建構中的 whisper.cpp builder stage
- 系統套件：`cmake`, `g++`, `make`, `git`, `pkg-config`（whisper.cpp 編譯需要的）
- `COPY whisper.cpp /build/whisper.cpp` 和對應 `RUN` 步驟
- ENTRYPOINT 中啟動 whisper-server 的部分（如有）
- whisper-server binary 的 COPY

**Build time 預期**：10–15 分鐘 → **1–3 分鐘**
**Image size 預期**：~3 GB → **~1.5 GB**（少了 whisper.cpp build tools + binary + 編譯產物）

### 10.6 移除的測試 / 修改的測試

| 測試檔 | 變化 |
|---|---|
| `tests/test_whisper.py` | 整個改寫：原本 mock HTTP whisper-server，改成測 faster-whisper wrapper |
| `tests/test_config.py` | 移除 `WHISPER_SERVER_PORT` 驗證、port 衝突檢查、URL parsing 測試 |
| `tests/test_api.py` | 更新 mocks（從 HTTP mock 改成 model mock） |
| `tests/test_files.py` | 不受影響 |
| `tests/test_punctuation.py` | 不受影響 |

**新增測試檔**：
- `tests/test_ask.py`（Gemini integration，mock SDK）
- `tests/test_stream.py`（WebSocket flow）

### 10.7 文件清理

| 檔案 | whisper-server 引用 | 清理工作 |
|---|---|---|
| `docs/TROUBLESHOOTING.md` | **15 處** | 重寫一大半，砍掉 whisper-server 故障排除、port 衝突、binary 路徑等小節 |
| `docs/API.md` | 6 處 | 移除 architecture 圖中的 whisper-server box，加 `/ask` 和 `/transcribe-stream` 文件 |
| `docs/INSTALLATION.md` | 1 處 | 移除 whisper.cpp build 段落、`git clone --recursive`、`make init-submodule` 步驟 |
| `README.md` | 多處 | 重寫架構章節 + Quick Start |
| `CLAUDE.md` | 大量 | 全章節重寫（移除 whisper.cpp 段落、port config 段落，加 streaming/PWA/ask 段落） |
| `AGENTS.md` | 待查 | 可能要小幅更新 |
| `CHANGELOG.md` | — | 加 v2.0.0 entry：列為 BREAKING CHANGE |

### 10.8 人工確認結果（2026-05-12 完成）

三項確認完成，相關行動已併入 §10.1 / §10.2：

| 項目 | 決議 | 行動 |
|---|---|---|
| `DOCKER_NAMING.md` | **刪除** | 加入 §10.1 完全刪除清單 |
| `doc/ios-shortcuts-workflow.jpeg` | **搬到 `docs/`** | 移動檔案、改 README 引用、刪 `.DS_Store`、刪空 `doc/` 目錄 |
| `scripts/model-manager.sh` | **重寫為 CT2 版**（~3–4 KB）| 加入 §10.2 大幅修改清單 |
| `./whisper-wrap` CLI wrapper | **刪除** | 加入 §10.1 完全刪除清單 |
| Shortcut 截圖 | **v2.0 後重拍** | 新 endpoint (`/transcribe` 統一、`/ask`) 流程不同，截圖要更新；併入 Phase 5 Shortcut UX |

### 10.9 向後相容性處理

⚠️ **這是 BREAKING CHANGE**（major version bump to v2.0.0）

| 項目 | 是否相容 | 說明 |
|---|---|---|
| `POST /transcribe` | ⚠️ 擴充 | 介面擴充：原 multipart 仍支援，**新增** raw audio body 支援（從 `/transcribe-raw` 合併過來） |
| `POST /transcribe-raw` | ❌ **移除** | 合併進 `/transcribe`，需更新自己的 iOS Shortcut URL（headers 不變） |
| `GET /health` | ❌ **移除** | 改名為 `/status`，回應 schema 擴充 |
| `WS /transcribe-stream` | ❌ **N/A**（從未發布）| 新版直接叫 `/listen` |
| `POST /ask` | ✨ 新增 | 不存在於 v1 |
| `.env` 設定檔 | ❌ 不相容 | 使用者必須更新（提供 migration guide） |
| `registry/models.yaml` schema | ❌ 不相容 | 自訂 entry 要重寫 |
| Docker image | ❌ 不相容 | 完全重建 |
| `make` 指令 | ⚠️ 部分相容 | 主要 target 保留，內部 target 移除 |

**Endpoint 重命名/移除一覽**：

| v1 | v2.0.0 | 原因 |
|---|---|---|
| `POST /transcribe` (multipart only) | `POST /transcribe` (multipart + raw) | 統一輸入路徑 |
| `POST /transcribe-raw` | （移除，合併進 `/transcribe`）| 去除冗餘 |
| `GET /health` | `GET /status` | 擴充為完整狀態回報 |
| — | `WS /listen` | 新增 streaming |
| — | `POST /ask` (含 `?stream=true`) | 新增語音/文字問答 |

### 10.10 清理數字摘要

```
刪除：
  ~310 行  Python (淨值)
  ~10 KB   Bash (model-manager.sh 簡化)
  53 MB    submodule
  3 個     根目錄餘檔（DOCKER_NAMING.md、doc/、./whisper-wrap）
  6 個     Makefile targets
  7 個     env vars
  3+ 個    Dockerfile build stages / system deps
  15 處    TROUBLESHOOTING.md 引用

新增：
  ~50 行   新 whisper wrapper (faster-whisper)
  ~80 行   /ask endpoint
  ~150 行  WebSocket streaming endpoint
  ~300 行  PWA frontend (HTML+JS+sw)
  5 個     新 env vars

Docker build 時間: 10–15 min → 1–3 min
Docker image size: ~3 GB → ~1.5 GB
跑起來的 process 數: 2 (FastAPI + whisper-server) → 1
```

---

## 附錄 A：今日決策摘要

- 量化目標選 **`int8_float16`**，非 bfloat16（bf16 對推理沒額外好處）
- VoiceInk 繼續用 GGML（不動），server 統一走 CT2
- 不做 native iOS app；PWA + Shortcut 雙軌
- Gemini 2.5 Flash 是 LLM 選擇（free tier 足夠個人使用）
- `/transcribe-stream` 用 sliding window + VAD（500–800ms 偽 streaming，不追真 streaming）
- 上 HF 用兩個 repo：`breeze-asr-25-ggml` + `breeze-asr-25-ct2`
