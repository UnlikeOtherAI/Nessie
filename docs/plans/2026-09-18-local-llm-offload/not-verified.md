# Not verified

Part of [the local LLM offload design](overview.md).

## 5. Not verified, stated plainly

No latency or quality numbers for Gemma 4 E2B/E4B exist in the tree — the
evidence is the harness's "nondeterministic tool selection" note and one local
`/v1` tool-call check on the 12B build; phase 0 exists for this. Why Ollama's
E2B Q4_K_M layer is 7.16 GB while the bartowski Q4_K_M GGUF is 3.46 GB and
Google's Q4_0 plus projector 4.34 GB was not established. That Ollama 0.34.1
imports a Gemma 4 GGUF through `/api/blobs` + `/api/create` with a working chat
template was not run — the endpoints were checked, the import was not; nor was
a `206` through an R2 custom domain, which Cloudflare's compatibility table
promises for the S3 endpoint and the public-bucket page does not mention. The
bucket, its domain and its lock do not exist yet; the layout in §2.3 is the
design, and the R2 prices are today's page. No measurement exists of Gemma 4
E2B/E4B tool-calling reliability under Ollama's `tools` on `/api/chat` — the
harness note says tool selection is nondeterministic, and the local tool loop
of §2.4 leans on exactly that; phase 0 scores it. `wsl.exe -d <distro> --exec
tmux capture-pane` was not run on a Windows host.
`docs/executor-protocol/overview.md` describes a WSS control stream and client
certificates the code does not implement; this design follows the implemented
poll loop and Ed25519 signatures. Gemma 4's terms were
checked only as far as the Apache-2.0 badge on the HF cards and the model card;
Ollama's manifest ships an 11 355-byte licence layer to be read at
implementation time and surfaced in the pull UI.
