# Video Coding & Media Reference & Deep Best Practices

## 1. Codec Selection Guide
- **H.264 / AVC**: Universal web/device compatibility. Use `-profile:v main` or `high`.
- **HEVC / H.265**: 30-50% bandwidth savings vs H.264 at high resolutions (4K).
- **AV1 (`libsvtav1`)**: Open, royalty-free next-gen web standard for high compression efficiency.

## 2. Audio Standards
- Resample multi-channel audio to stereo AAC 128-192kbps for broad mobile playback.
