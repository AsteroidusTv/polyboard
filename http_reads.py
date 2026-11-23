"""Reuse authenticated TLS connections for read-only Polymarket API requests."""

import gzip
import json
from http.client import HTTPException, HTTPSConnection, RemoteDisconnected
from queue import Empty, Full, LifoQueue
from ssl import create_default_context
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, getproxies, proxy_bypass, urlopen


HEADERS = {"Accept": "application/json", "Accept-Encoding": "gzip",
           "User-Agent": "PolymarketLocalDashboard/1.0"}
TLS = create_default_context()


def decode_json(body, encoding):
    return json.loads(gzip.decompress(body) if encoding == "gzip" else body)


class JsonOrigin:
    def __init__(self, host):
        self.host = host
        self.idle = LifoQueue(maxsize=12)

    def fallback(self, url, timeout):
        with urlopen(Request(url, headers=HEADERS), timeout=timeout) as response:
            return decode_json(response.read(), response.headers.get("Content-Encoding"))

    def read(self, path, params, timeout):
        target = "/" + path.lstrip("/") + "?" + urlencode(params)
        url = f"https://{self.host}{target}"
        if getproxies().get("https") and not proxy_bypass(self.host):
            return self.fallback(url, timeout)

        try:
            connection = self.idle.get_nowait()
        except Empty:
            connection = None

        while True:
            reused = connection is not None
            connection = connection or HTTPSConnection(self.host, timeout=timeout, context=TLS)
            try:
                if connection.sock is not None:
                    connection.sock.settimeout(timeout)
                connection.request("GET", target, headers=HEADERS)
                with connection.getresponse() as response:
                    body = response.read()
                    status, headers, reason = response.status, response.headers, response.reason
                    keep = not response.will_close and connection.sock is not None
            except (OSError, HTTPException) as error:
                connection.close()
                if reused and isinstance(error, (RemoteDisconnected, BrokenPipeError, ConnectionResetError)):
                    connection = None
                    continue
                if isinstance(error, TimeoutError):
                    raise
                raise URLError(error) from error
            if keep:
                try:
                    self.idle.put_nowait(connection)
                except Full:
                    connection.close()
            else:
                connection.close()
            if status in (301, 302, 303, 307, 308) and headers.get("Location"):
                return self.fallback(url, timeout)
            if not 200 <= status < 300:
                raise HTTPError(url, status, reason, headers, None)
            try:
                return decode_json(body, headers.get("Content-Encoding"))
            except (OSError, EOFError) as error:
                raise ValueError("Unreadable compressed API response") from error


DATA = JsonOrigin("data-api.polymarket.com")
GAMMA = JsonOrigin("gamma-api.polymarket.com")


def data_request(resource, params, timeout=10):
    return DATA.read("v2/" + resource, params, timeout)
