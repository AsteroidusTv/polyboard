"""Serve small WebP variants of the dashboard's public Polymarket artwork."""

import re
from io import BytesIO
from threading import BoundedSemaphore
from urllib.request import HTTPRedirectHandler, build_opener

from read_cache import ReadCache

try:
    from PIL import Image, ImageOps, features
except ImportError:
    Image = None

ENABLED = Image is not None and features.check("webp")
ORIGIN = "https://polymarket-upload.s3.us-east-2.amazonaws.com/"
PATH = "/media/market/v1/"
FILENAME = re.compile(r"[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,190}\.(?:png|jpe?g|webp)", re.I)
SOURCE_LIMIT = 3 * 1024 * 1024
PIXEL_LIMIT = 12_000_000
SIZE = (128, 128)
THUMBNAILS = ReadCache(1024)
WORKERS = BoundedSemaphore(6)


class DirectDownload(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


DOWNLOAD = build_opener(DirectDownload())


def resize(content):
    try:
        with Image.open(BytesIO(content), formats=("JPEG", "PNG", "WEBP")) as original:
            if original.width * original.height > PIXEL_LIMIT:
                raise ValueError("Market artwork exceeds the resize limit")
            original.draft("RGB", SIZE)
            image = ImageOps.exif_transpose(original)
            if image.mode not in ("RGB", "RGBA"):
                transparent = "A" in image.getbands() or "transparency" in image.info
                image = image.convert("RGBA" if transparent else "RGB")
            image.thumbnail(SIZE, Image.Resampling.LANCZOS)
            result = BytesIO()
            image.save(result, "WEBP", quality=82, method=3)
            return result.getvalue()
    except Image.DecompressionBombError as error:
        raise ValueError("Market artwork exceeds the resize limit") from error


def thumbnail(name):
    if not ENABLED or not FILENAME.fullmatch(name):
        raise ValueError("Thumbnail unavailable")

    def load():
        if not WORKERS.acquire(timeout=2):
            raise TimeoutError("Thumbnail server busy")
        try:
            with DOWNLOAD.open(ORIGIN + name, timeout=3) as response:
                content = response.read(SOURCE_LIMIT + 1)
            if len(content) > SOURCE_LIMIT:
                raise ValueError("Market artwork exceeds the download limit")
            return resize(content)
        finally:
            WORKERS.release()

    return THUMBNAILS.read(name, load, ttl=86400)
