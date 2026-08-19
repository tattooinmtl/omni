---
name: video-coding
description: >-
  Production video coding, media processing pipelines, FFmpeg integration, WebCodecs, H.264/HEVC/AV1 transcoding, streaming (HLS/DASH), OpenCV, and harness verification.
---

# Video Coding & Media Processing Skill

Operational guide, architecture starter, best practices, and harness controls for video encoding, streaming pipelines, hardware acceleration, and WebCodecs / FFmpeg integration.

## 1. Stack Overview & Dependencies
- **Core CLI & Libraries**: `ffmpeg` / `ffprobe`, `libavcodec`, `libx264`, `libx265`, `libsvtav1`
- **Python Media Tools**: `ffmpeg-python`, `opencv-python` (`cv2`), `av` (PyAV), `moviepy`
- **JS / Browser Standards**: `WebCodecs API` (`VideoEncoder`, `VideoDecoder`), `hls.js`, `video.js`, `mediainfo.js`
- **Hardware Acceleration**: NVENC (`h264_nvenc`, `hevc_nvenc`), QuickSync (`h264_qsv`), VAAPI, Apple VideoToolbox

## 2. Standard Codebase Structure
```text
video-pipeline/
├── README.md
├── scripts/
│   ├── transcode.sh
│   └── generate_hls.sh
├── src/
│   ├── pipeline.py
│   ├── encoders/
│   └── metadata/
└── tests/
    └── test_pipeline.py
```

## 3. How-To Workflows

### Transcode Video (H.264 / AAC baseline)
```bash
ffmpeg -i input.mp4 -c:v libx264 -preset slow -crf 22 -c:a aac -b:a 128k output.mp4
```

### Create HLS Adaptive Bitrate Stream
```bash
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3]; [v1]scale=w=1920:h=1080[v1out]; [v2]scale=w=1280:h=720[v2out]; [v3]scale=w=854:h=480[v3out]" \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 5000k \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 2800k \
  -map "[v3out]" -c:v:2 libx264 -b:v:2 1400k \
  -map a:0 -c:a aac -b:a 128k \
  -f hls -hls_time 6 -hls_playlist_type vod stream.m3u8
```

### Python Processing Execution
```bash
python src/pipeline.py --input sample.mp4 --codec h264 --preset fast
```

## 4. Best Practices & Design Patterns
1. **CRF vs Two-Pass Bitrate**: Use Constant Rate Factor (`-crf 18..24`) for VOD/archival encoding and two-pass CBR/VBR for bandwidth-constrained streaming.
2. **GOP Size & Keyframe Alignment**: Set closed Keyframe Intervals (`-g 60 -keyint_min 60 -sc_threshold 0`) to allow smooth segment switching in HLS/DASH.
3. **Async / Non-blocking Subprocessing**: Never block thread loops waiting for long FFmpeg commands without progress parsing.
4. **Hardware Encoder Fallback**: Always wrap NVENC/QSV invocations with automatic software (`libx264`) fallback if GPU encoding fails.
5. **WebCodecs Browser Offloading**: Use browser native `VideoEncoder` for client-side recording to prevent canvas capture lag.

## 5. Tips, Tricks & Pitfalls
- **Audio/Video Desync**: Ensure frame rates (`-r`) and sample rates (`-ar 44100` / `48000`) match source timestamps.
- **Fast Start Moov Atom**: Always add `-movflags +faststart` for web MP4 playback so metadata moov atom is placed at the file head.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Validate FFmpeg input paths and check GPU availability before executing heavy render jobs.
- **PostToolUse Verification**: Probe output media files (`ffprobe`) to confirm duration, stream counts, and zero corrupted frames.
