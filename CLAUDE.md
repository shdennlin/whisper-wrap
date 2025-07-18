# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

whisper-wrap is a FastAPI-based wrapper service that provides universal audio transcription by:
1. Accepting audio files in any format via POST endpoint
2. Converting files to WAV using ffmpeg
3. Calling local whisper-server for transcription
4. Returning JSON results and cleaning up temporary files

## Architecture

The service acts as a proxy/adapter between clients and whisper.cpp's whisper-server, handling format conversion and temporary file management.

**Core Components:**
- FastAPI web server for HTTP API
- ffmpeg integration for audio format conversion  
- HTTP client for whisper-server communication
- Temporary file management with automatic cleanup

**External Dependencies:**
- whisper-server: Local instance expected at `localhost:9000`
- ffmpeg: System binary for audio conversion
- Whisper model: Expected at `./models/ggml-large-v3-turbo-q8_0.bin`

## whisper-server Setup

Start the required whisper-server dependency:
```bash
./build/bin/whisper-server --host 0.0.0.0 --port 9000 -m ./models/ggml-large-v3-turbo-q8_0.bin -l 'auto' -tdrz
```

## API Contract

**Input:** POST with audio file
**Processing:** Convert to WAV → Call whisper-server `/inference`
**Output:** JSON transcription response
**Cleanup:** Remove temporary files

whisper-server expects:
- File: audio.wav
- temperature: 0.0
- temperature_inc: 0.2
- response_format: json