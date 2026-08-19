"""
Production Video Processing Pipeline Starter
Python wrapper around ffmpeg subprocessing with metadata probing and faststart optimization.
"""

import subprocess
import json
import os
import sys
from typing import Dict, Any, Optional

class MediaProbe:
    @staticmethod
    def get_metadata(input_path: str) -> Dict[str, Any]:
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            input_path
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return json.loads(res.stdout)
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            return {"error": f"Failed to probe file: {e}"}

class VideoEncoderEngine:
    def __init__(self, ffmpeg_bin: str = "ffmpeg"):
        self.ffmpeg_bin = ffmpeg_bin

    def transcode_to_web_mp4(
        self,
        input_path: str,
        output_path: str,
        preset: str = "fast",
        crf: int = 23
    ) -> bool:
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-i", input_path,
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            output_path
        ]
        
        print(f"[VideoEncoderEngine] Running command: {' '.join(cmd)}")
        try:
            subprocess.run(cmd, check=True)
            return True
        except subprocess.CalledProcessError as e:
            print(f"[VideoEncoderEngine] Encoding error: {e}", file=sys.stderr)
            return False

if __name__ == "__main__":
    print("=== Video Coding Processing Pipeline Starter ===")
    print("Probe & Transcode utility initialized.")
