# Launch

A local AI runner with its own inference engine, the **Launch engine**. It downloads models from Hugging Face, runs them on your GPU (or CPU), and serves an OpenAI-compatible API that KSTRL connects to. It also handles API keys and daily usage for every KSTRL install.

> Basic first version: it works end to end, but it isn't pretty or fast yet. See **Limits** below.

## Download (Windows)

Get **Launch.exe** from the KSTRL repo's Releases page (the `launch-v…` pre-release) and double-click it. The first run sets up Launch's own Python and PyTorch: the GPU version if you have an NVIDIA card (about 2.5 GB), otherwise the CPU version (about 250 MB). Everything goes in `%LOCALAPPDATA%\Launch`, and models in `%USERPROFILE%\.launch\models`.

Double-clicking opens the Launch window with tabs for **Models** (download from Hugging Face, delete), **Server** (pick a model, port, context size, start/stop, copy the API URL for KSTRL), **Chat** (test the running model), **API keys** (create, MAX/Free, revoke), **Accounts** (people who signed up from KSTRL) and **Setup / log**. You can also run it from a terminal with the same commands as below, e.g. `Launch.exe serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000`.

To build the exe yourself, run the **Build Launch** workflow on GitHub (Actions tab).

## Install from source

Needs Python 3.10+.

```bash
cd launch
pip install -e .
```

With an NVIDIA GPU, install PyTorch with CUDA first, following the instructions at pytorch.org (pick your CUDA version), then run `pip install -e .`. Apple Silicon Macs use the GPU automatically.

## Use it

```bash
launch pull Qwen/Qwen2.5-Coder-7B-Instruct      # download from Hugging Face
launch list                                      # what's downloaded
launch run Qwen/Qwen2.5-Coder-7B-Instruct "Write a Python function that reverses a string"
launch serve Qwen/Qwen2.5-Coder-7B-Instruct --host 0.0.0.0 --port 8000
```

Private or gated models need a Hugging Face token: `launch pull <repo> --token hf_…`, or set `HF_TOKEN`.

`serve` options: `--ctx 8192` (context length), `--device cuda|mps|cpu`, `--no-auth` (no keys, only for use on your own PC).

## API

| Endpoint | What it does |
|---|---|
| `GET /v1/models` | The loaded model |
| `POST /v1/chat/completions` | OpenAI-compatible chat, streaming, tool calling, `stream_options.include_usage` |
| `POST /v1/kstrl/register` | Gives each KSTRL install its own Free key (same `install_id` gets the same key; max 3 new keys per IP per day) |
| `GET /v1/kstrl/account` | Plan and today's usage for a key |
| `POST /v1/kstrl/crash` | Crash reports from KSTRL (saved to `~/.launch/crash.log`) |
| `GET /health` | Status check |

Every endpoint except register and health needs `Authorization: Bearer <key>`.

Daily limits: Free 2,500 credits, MAX 50,000 (UTC days). The credits formula matches KSTRL (`docs/website-login.md` in the KSTRL repo). When a key runs out, chat returns 429 `usage_limit`.

## Keys

```bash
launch keys list                          # every key with today's usage
launch keys create --plan max --name Amir # make a key by hand (shown once)
launch keys plan sk-launch-abc123 max     # upgrade a key (prefix, full key or install id)
launch keys revoke sk-launch-abc123
launch keys ban <install id>
```

Keys and usage live in `~/.launch/launch.db`; models live in `~/.launch/models/`.

## Connecting KSTRL

1. Run `launch serve <model> --host 0.0.0.0 --port 8000` on the machine with the GPU.
2. Make it reachable over HTTPS, e.g. with a Cloudflare Tunnel, or nginx/Caddy with a certificate in front of port 8000.
3. In GitHub (KSTRL repo → Settings → Secrets and variables → Actions → Variables), set `KSTRL_API_URL` to that address and publish a new KSTRL version.

New KSTRL installs then get a key automatically and start chatting. On your own PC you can skip all of that: in KSTRL, Log in → "Or paste an API key instead", with URL `http://127.0.0.1:8000` and a key from `launch keys create`.

## The Launch engine

`launch/engine.py`, written from scratch on PyTorch tensors. It doesn't use llama.cpp or Hugging Face transformers:

- Reads `config.json` and the `.safetensors` weights directly (sharded checkpoints included).
- Architectures: **Llama 1/2/3.x, Mistral, Qwen2/Qwen2.5 (incl. Coder), Qwen3, Gemma 1/2/3**.
- RMSNorm, rotary embeddings (with Llama 3 scaling), grouped-query attention, Qwen's QKV biases and Qwen3's Q/K norms, and SwiGLU.
- A preallocated KV cache with prefix reuse, so follow-up messages in a chat don't re-process the whole conversation.
- Sampling with temperature, top-k and top-p; streaming text that's safe for multi-byte characters.
- Chat formatting with each model's own template (`tokenizer_config.json`), and tool calls parsed from `<tool_call>` blocks (Qwen/Hermes style).

Tested to give the same outputs as Hugging Face's reference implementation (differences around 1e-7) on Qwen2, Qwen3 and Llama-3-style models.

### How much memory models need (16-bit on GPU)

| Model size | VRAM |
|---|---|
| 1.5B | ~4 GB |
| 7B | ~16 GB |
| 14B | ~30 GB |

On CPU it uses 32-bit floats: twice the memory and much slower. CPU is only practical for models of about 1.5B or smaller.

## Limits (next steps)

- **One request at a time** (others wait in line); no batching yet.
- **No quantization yet,** so 4-bit/8-bit models such as `-bnb-4bit` repos can't load. Use the full-precision repos.
- **Text only:** images sent from KSTRL are replaced with a note.
- **Tool calls follow the Qwen/Hermes format.** Qwen2.5-Coder and Qwen3 work best with KSTRL's agent.
- **One model per server.** Run another `launch serve` on a different port for a second model.
