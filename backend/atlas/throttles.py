from rest_framework.throttling import SimpleRateThrottle


class WriteThrottle(SimpleRateThrottle):
    scope = "write"

    def get_cache_key(self, request, view):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        identity = f"user:{request.user.pk}" if request.user.is_authenticated else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": identity}


class AuthThrottle(WriteThrottle):
    scope = "auth"

    def get_cache_key(self, request, view):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
