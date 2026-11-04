# Agentic AI — Coding Agent

Coding agent CLI yang dibangun dengan **LangGraph**, **TypeScript**, **Ollama/LM Studio**, dan **SQLite**. Agent bisa membaca repository, mencari kode, mengedit file, dan menjalankan command—dengan approval interaktif sebelum aksi yang mengubah file atau mengeksekusi shell.

## Fitur

- Graph agent ReAct: `agent → tools → agent` dengan tool calling.
- LLM lokal lewat **Ollama** (`ChatOllama`) atau **LM Studio** (OpenAI-compatible API).
- Human-in-the-loop: `write_file`, `edit_file`, dan `run_command` wajib disetujui.
- Sandbox path: semua akses file dibatasi ke workspace target.
- Memory percakapan persisten dengan SQLite (`SqliteSaver`).
- Streaming token ke terminal.
- Tool read-only: `list_files`, `read_file`, `search_code`, `git_status`, `git_diff`.
- Tool dengan approval: `write_file`, `edit_file`, `run_command`.
- CLI interaktif dengan thread: `/new`, `/thread`, `/history`, `/exit`.

## Prasyarat

- Node.js >= 22 (diuji dengan Node 26)
- pnpm 12+
- Salah satu provider LLM lokal:
  - **Ollama** yang sudah berjalan, atau
  - **LM Studio** dengan server OpenAI-compatible aktif (biasanya port `1234`)
- Model yang mendukung **tool calling** (misalnya `qwen2.5-coder:7b` atau `qwen2.5-7b-instruct`)
- `ripgrep` (`rg`) opsional untuk `search_code` yang lebih cepat; ada fallback JavaScript
- `git` opsional untuk `git_status` dan `git_diff`

## Quick Start

### 1. Install dependency

```bash
pnpm install
```

> `better-sqlite3` adalah native module. Jika tidak ada prebuilt binary untuk Node kamu, install `python3`, `make`, dan `g++` terlebih dahulu.

### 2. Siapkan provider LLM

Pilih salah satu provider. Keduanya berjalan lokal.

#### Opsi A — Ollama

Jalankan Ollama sesuai cara yang kamu pakai, lalu pull model:

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

Jika memakai Docker:

```bash
docker run -d --name ollama -p 11434:11434 \
  -v ollama:/root/.ollama ollama/ollama

docker exec -it ollama ollama pull qwen2.5-coder:7b
```

Cek bahwa Ollama dan model sudah siap:

```bash
curl http://127.0.0.1:11434/api/tags
```

#### Opsi B — LM Studio

1. Load model yang mendukung tool calling, misalnya `qwen2.5-7b-instruct`.
2. Buka tab **Developer** di LM Studio, lalu klik **Start Server** (default port `1234`).
3. Pastikan endpoint OpenAI-compatible aktif, lalu cek:

```bash
curl http://127.0.0.1:1234/v1/models
```

LM Studio memakai **OpenAI-compatible API**, bukan API Ollama. Karena itu base URL-nya harus diakhiri `/v1` dan **jangan** diarahkan ke port Ollama `11434`.

### 3. Konfigurasi

```bash
cp .env.example .env
```

Untuk Ollama:

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:7b
WORKSPACE_DIR=/home/user/code/projek/lain
```

Untuk LM Studio:

```env
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=qwen2.5-7b-instruct
LMSTUDIO_API_KEY=lm-studio
WORKSPACE_DIR=/home/user/code/projek/lain
```

`LMSTUDIO_MODEL` harus sama persis dengan `id` dari `curl http://127.0.0.1:1234/v1/models`.

Atau lewati `.env` dan pakai flag CLI:

```bash
pnpm dev --dir /home/user/code/projek/lain --provider lmstudio --model qwen2.5-7b-instruct
```

### 4. Jalankan

```bash
pnpm dev --dir /home/user/code/projek/lain
```

Atau setelah build:

```bash
pnpm build
pnpm run start --dir /home/user/code/projek/lain
```

## Cara Pakai

Contoh percakapan:

```text
you  jelaskan struktur project ini
agent → tool list_files({"path":".","depth":2})
      ...

you  tambahkan validasi email di src/validators/user.ts
agent → tool read_file({"path":"src/validators/user.ts"})
      → tool edit_file({"path":"src/validators/user.ts", ...})

⚠ Persetujuan diperlukan
edit_file (call_abc123)
{ "path": "src/validators/user.ts", ... }
Setujui edit_file? [y/N] y

agent Saya menambahkan validasi email ...
```

### Perintah CLI

| Perintah | Fungsi |
|---|---|
| `/help` | Tampilkan bantuan |
| `/new` | Mulai thread percakapan baru |
| `/thread` | Tampilkan thread id aktif |
| `/thread <id>` | Lanjutkan thread tertentu |
| `/history` | Tampilkan 20 pesan terakhir |
| `/exit` | Keluar |

### Opsi CLI

```text
-d, --dir <path>        Workspace/repo target
-C, --workspace <path>  Alias untuk --dir
-p, --provider <name>   ollama | lmstudio
    --base-url <url>    Override base URL provider
-m, --model <name>      Nama model (default tergantung provider)
    --db <path>         Path SQLite
-h, --help              Bantuan
-v, --version           Versi
```

## Arsitektur Graph

```text
START → agent
          │
          ├── tidak ada tool call ─────────────────────→ END
          │
          ├── tool read-only ───────────────→ tools ──→ agent
          │
          └── tool butuh approval → approval → tools ──→ agent
                                      │
                                      └── interrupt() menunggu y/N
```

- `agent` memanggil LLM dengan tool yang sudah di-bind.
- `approval` memakai `interrupt()` LangGraph. Keputusan user disimpan di checkpoint SQLite.
- `tools` mengeksekusi tool call, termasuk mengubah penolakan user menjadi `ToolMessage`.
- Model bisa melihat hasil tool dan melanjutkan sampai selesai.

### Tools

| Tool | Approval | Keterangan |
|---|---|---|
| `list_files` | tidak | List file/direktori, skip `.git`, `node_modules`, `.ssh`, `dist` |
| `read_file` | tidak | Baca file, bisa `startLine`/`endLine` |
| `search_code` | tidak | Regex search, ripgrep + fallback JS |
| `git_status` | tidak | Status git singkat |
| `git_diff` | tidak | Diff workspace atau path tertentu |
| `write_file` | **ya** | Buat/timpa file |
| `edit_file` | **ya** | Replace teks exact |
| `run_command` | **ya** | Shell non-interaktif dengan timeout |

## Konfigurasi Environment

| Variable | Default | Keterangan |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` atau `lmstudio` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Base URL server Ollama |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Model Ollama |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | Endpoint OpenAI-compatible LM Studio |
| `LMSTUDIO_MODEL` | `qwen2.5-7b-instruct` | `id` model yang di-load di LM Studio |
| `LMSTUDIO_API_KEY` | `lm-studio` | API key dummy untuk LM Studio |
| `WORKSPACE_DIR` | _(kosong)_ | Repo target; wajib jika tidak pakai `--dir` |
| `SQLITE_PATH` | `./data/checkpoints.sqlite` | Lokasi database memory |
| `MAX_ITERATIONS` | `25` | Batas langkah graph per turn |
| `COMMAND_TIMEOUT_MS` | `30000` | Timeout default `run_command` |
| `MAX_OUTPUT_CHARS` | `20000` | Batas output tool/command |
| `MAX_FILE_BYTES` | `200000` | Batas ukuran file yang dibaca |

`SQLITE_PATH` relatif terhadap direktori project agent, bukan workspace target.

Saat `LLM_PROVIDER=lmstudio`, aplikasi memakai `ChatOpenAI` dengan `baseURL` dari `LMSTUDIO_BASE_URL`. Saat `LLM_PROVIDER=ollama`, aplikasi memakai `ChatOllama`.

## Struktur Project

```text
src/
├── index.ts                 # entry point + parsing argumen
├── config.ts                # env & validasi
├── agent/
│   ├── model.ts             # ChatOllama/ChatOpenAI + preflight check
│   ├── state.ts             # StateSchema + messages + approvals
│   ├── graph.ts             # StateGraph + approval interrupt
│   ├── prompt.ts            # system prompt
│   └── tools/
│       ├── index.ts         # registry tool + daftar tool berbahaya
│       ├── filesystem.ts    # list/read/write/edit
│       ├── search.ts        # search_code
│       └── shell.ts         # run_command + git
├── memory/
│   └── sqlite.ts            # SqliteSaver
├── cli/
│   ├── repl.ts              # loop chat + streaming
│   └── approval.ts          # prompt y/N
└── utils/
    ├── paths.ts             # sandbox path guard
    └── output.ts            # truncate & formatting
tests/
├── paths.test.ts
├── tools.test.ts
├── graph.test.ts
├── model.test.ts
└── sqlite.test.ts
```

## Menambah Tool Baru

1. Buat tool dengan `tool()` dari `@langchain/core/tools`.
2. Daftarkan di `src/agent/tools/index.ts` dalam `createTools()`.
3. Jika tool mengubah file atau mengeksekusi command, tambahkan namanya ke `DANGEROUS_TOOLS` agar wajib approval.

Contoh:

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const countLines = tool(
  async ({ path }) => {
    // implementasi
    return "42";
  },
  {
    name: "count_lines",
    description: "Hitung jumlah baris sebuah file.",
    schema: z.object({ path: z.string() }),
  },
);
```

## Development

```bash
pnpm dev --dir /path/ke/repo   # jalankan CLI
pnpm dev:watch --dir /path/ke/repo # watch mode (restart saat file berubah)
pnpm typecheck                    # cek TypeScript
pnpm test                         # unit + integration test (tanpa Ollama)
pnpm build                        # compile ke dist/
pnpm run start --dir /path/ke/repo # jalankan hasil build
```

Test graph memakai model palsu dan test provider memakai HTTP server tiruan, jadi tidak membutuhkan Ollama maupun LM Studio.

## Troubleshooting

**`Tidak bisa terhubung ke Ollama`**
- Pastikan Ollama berjalan.
- Cek `curl http://127.0.0.1:11434/api/tags`.
- Jika Ollama di mesin lain, set `OLLAMA_BASE_URL`.

**`Model "..." belum tersedia`**
```bash
ollama pull qwen2.5-coder:7b
```
Atau ganti `OLLAMA_MODEL` ke model yang sudah ada.

**Agent tidak memanggil tool**
- Pastikan model mendukung tool calling.
- Coba model yang lebih capable, misalnya `qwen2.5-coder:7b`.
- Model kecil kadang perlu prompt yang lebih eksplisit.

**Terlalu lambat**
- Tanpa GPU, model 7B bisa lambat. Coba `qwen2.5-coder:3b` atau `qwen3:4b`.
- Kurangi `numCtx` di `src/agent/model.ts` jika RAM terbatas.

**`better-sqlite3` gagal build**
```bash
sudo apt install python3 make g++
pnpm rebuild better-sqlite3
```

**Percakapan terasa “nyangkut”**
- Gunakan `/new` untuk thread baru.
- Cek `/history` untuk melihat state terakhir.

**Percakapan panjang mulai aneh atau kehabisan konteks**
- Model default memakai context 8192 token (`numCtx` di `src/agent/model.ts`).
- Gunakan `/new` untuk memulai konteks baru, atau naikkan `numCtx` jika RAM cukup.

## Keamanan & Batasan

- Sandbox path berlaku untuk semua tool file. Path di luar workspace, `.env`, `.git/`, `node_modules/`, `.ssh/`, dan private key diblokir.
- `run_command` berjalan dengan permission user, bukan container/OS jail. Approval adalah lapisan keamanan utama.
- Command berbahaya seperti `sudo`, `rm -rf /`, `mkfs`, `dd if=`, dan `curl | sh` diblokir, tetapi tidak semua kemungkinan bisa dideteksi.
- Jangan arahkan agent ke repository sensitif tanpa review. Selalu baca detail aksi sebelum menekan `y`.
- Prompt approval memotong argumen tool yang sangat panjang. Setelah perubahan, tinjau hasil lengkap dengan `git_diff`.
- Agent tidak melakukan `git commit` atau `git push` secara otomatis; semua lewat `run_command` dan approval.

## Lisensi

ISC
# Ai-agent-Langchain
