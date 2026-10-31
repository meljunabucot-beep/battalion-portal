from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///./portal.db"
    session_secret: str = "change-me"
    session_max_age: int = 60 * 60 * 24 * 7
    storage_dir: str = "./storage"
    storage_public_url: str = "/files"
    max_upload_mb: int = 25
    max_backup_mb: int = 500
        # ---- Timezone (for calendar + "tomorrow" notifications) ----
    timezone: str = "Asia/Manila"

    # ---- Login lockout ----
    max_login_attempts: int = 5
    login_lockout_seconds: int = 600   # 10 minutes

    # ---- PDF preview (LibreOffice conversion) ----
    enable_pdf_preview: bool = True

    # ---- Security / deployment ----
    environment: str = "development"
    domain: str = "localhost"
    force_https: bool = False
    extra_allowed_hosts: str = ""

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def allowed_hosts(self) -> list[str]:
        hosts = ["localhost", "127.0.0.1"]
        if self.domain and self.domain != "localhost":
            hosts.append(self.domain)
            if "." in self.domain:
                hosts.append(f"www.{self.domain}")
        for h in self.extra_allowed_hosts.split(","):
            h = h.strip()
            if h:
                hosts.append(h)
        return hosts

    class Config:
        env_file = ".env"

settings = Settings()