# EchoTrace

Meeting notes from recordings, with timestamped evidence.

English · [中文](README_zh.md)

## Requirements

Python 3.11+, [uv](https://docs.astral.sh/uv/), and ffmpeg.

```bash
uv sync
```

The FunASR models (~2.8 GB) download automatically from ModelScope to `.cache/modelscope/` on the first transcription, and are loaded fully offline afterwards.

## Usage

**1. Prepare the public reference set** (optional)

Download `Eval_Ali.tar.gz` from [AliMeeting](https://www.openslr.org/119/), unpack the near-field data, then run:

```bash
uv run python scripts/make_alimeeting_clips.py --src ~/Eval_Ali/Eval_Ali_near
```

Output goes to `data/public/alimeeting/`: `clips/` audio, `ref/` human transcripts, and `manifest.csv` with the source of each clip.

**2. Transcribe and compute CER**

```bash
uv run python scripts/eval_cer.py
```

Results are written to `results/alimeeting_cer.csv`. Transcripts are cached in `data/cache/asr/`.

**3. Export drafts for manual correction**

```bash
uv run python scripts/export_transcript.py data/private/audio
```

Exports the ASR draft as one sentence per line with its time span (default: `data/private/corrected/`). Correct the text while listening; the edited file becomes the human-corrected transcript. The raw transcript stays untouched in the cache, and existing drafts are skipped rather than overwritten.

## Layout

```
src/echotrace/asr.py              local transcription + caching
src/echotrace/transcript.py       read/write the correction format
scripts/make_alimeeting_clips.py  cut clips from AliMeeting
scripts/eval_cer.py               CER evaluation
scripts/export_transcript.py      export drafts for correction
data/public/                      public datasets (audio not committed)
data/private/                     private recordings, transcripts, annotations (whole directory not committed)
data/cache/                       ASR cache (not committed)
results/                          evaluation results
```

## Data and privacy

- Private recordings require prior consent from the participants and are processed locally only — never uploaded or published.
- Audio is transcribed offline on the local machine; only short text snippets are sent to the text API.
- All timestamps come from the transcription or from manual checking, never from an LLM's guess.

The AliMeeting dataset is licensed CC BY-SA 4.0; see [OpenSLR 119](https://www.openslr.org/119/) for citation.
