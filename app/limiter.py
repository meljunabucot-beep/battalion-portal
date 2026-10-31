import ipaddress
from fastapi import Request
from slowapi import Limiter


def real_client_ip(request: Request) -> str:
    """
    Extract the real client IP when running behind Cloudflare (Tunnel or Proxy).

    Trust chain:
      • cf-connecting-ip  — set by Cloudflare, one value, highest trust.
      • x-forwarded-for   — comma-separated; leftmost is the client.
      • request.client.host — socket peer (127.0.0.1 when cloudflared is local).

    We only accept values that parse as valid IP addresses to avoid header
    injection attacks.
    """
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        try:
            ipaddress.ip_address(cf_ip.strip())
            return cf_ip.strip()
        except ValueError:
            pass

    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        if hops:
            try:
                ipaddress.ip_address(hops[0])
                return hops[0]
            except ValueError:
                pass

    return request.client.host if request.client else "unknown"


limiter = Limiter(key_func=real_client_ip)