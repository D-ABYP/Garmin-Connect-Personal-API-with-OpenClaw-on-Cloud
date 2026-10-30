import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from email.message import EmailMessage
import hashlib
import json
import os
from pathlib import Path
import re
import smtplib
import sys


DEFAULT_CONFIG_FILE = Path("~/.config/garmin/email.env")
DEFAULT_STATE_FILE = Path("~/.config/garmin/notify-state.json")


class NotifyError(Exception):
    pass


@dataclass(frozen=True)
class SmtpConfig:
    host: str
    port: int
    username: str
    password: str = field(repr=False)
    sender: str
    recipients: list[str]
    security: str
    timeout: float


def parse_env(path: Path) -> dict[str, str]:
    try:
        lines = path.expanduser().read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise NotifyError("Unable to read the SMTP configuration file") from error

    values: dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise NotifyError("SMTP configuration contains an invalid line")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def load_config(path: Path) -> SmtpConfig:
    values = parse_env(path)
    required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_TO"]
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise NotifyError(f"Missing SMTP configuration: {', '.join(missing)}")

    try:
        port = int(values["SMTP_PORT"])
        timeout = float(values.get("SMTP_TIMEOUT", "30"))
    except ValueError as error:
        raise NotifyError("SMTP_PORT and SMTP_TIMEOUT must be numeric") from error
    if not 1 <= port <= 65535 or timeout <= 0:
        raise NotifyError("SMTP port or timeout is outside the valid range")

    security = values.get("SMTP_SECURITY", "starttls").lower()
    if security not in {"ssl", "starttls", "none"}:
        raise NotifyError("SMTP_SECURITY must be ssl, starttls, or none")
    recipients = [recipient.strip() for recipient in values["SMTP_TO"].split(",") if recipient.strip()]
    if not recipients:
        raise NotifyError("SMTP_TO must contain at least one recipient")

    return SmtpConfig(
        host=values["SMTP_HOST"],
        port=port,
        username=values["SMTP_USERNAME"],
        password=values["SMTP_PASSWORD"],
        sender=values["SMTP_FROM"],
        recipients=recipients,
        security=security,
        timeout=timeout,
    )


def sanitize(value: object, secrets: list[str] | None = None) -> str:
    text = str(value)
    for secret in sorted((item for item in secrets or [] if item), key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)\b(Bearer|ApiKey)\s+[^\s,;]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)(SMTP_PASSWORD\s*=\s*)[^\s,;]+", r"\1[REDACTED]", text)
    return text


def send_message(config: SmtpConfig, message: EmailMessage) -> None:
    message["From"] = config.sender
    message["To"] = ", ".join(config.recipients)
    try:
        smtp_type = smtplib.SMTP_SSL if config.security == "ssl" else smtplib.SMTP
        with smtp_type(config.host, config.port, timeout=config.timeout) as smtp:
            if config.security == "starttls":
                smtp.starttls()
            smtp.login(config.username, config.password)
            smtp.send_message(message)
    except Exception as error:
        raise NotifyError(f"SMTP operation failed: {sanitize(error, [config.password, config.username])}") from error


def send_test(config: SmtpConfig) -> None:
    message = EmailMessage()
    message["Subject"] = "Garmin Coach SMTP test"
    message.set_content("This is a Garmin Coach SMTP configuration test.\n", charset="utf-8")
    send_message(config, message)


def state_path() -> Path:
    return Path(os.environ.get("GARMIN_NOTIFY_STATE_FILE", str(DEFAULT_STATE_FILE))).expanduser()


def read_state(path: Path) -> dict[str, str]:
    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise NotifyError("Unable to read the notification state") from error
    try:
        state = json.loads(contents)
    except json.JSONDecodeError as error:
        raise NotifyError("Notification state is invalid") from error
    if not isinstance(state, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in state.items()):
        raise NotifyError("Notification state has an invalid format")
    return state


def write_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(state, file, ensure_ascii=False, indent=2, sort_keys=True)
            file.write("\n")
        os.replace(temporary, path)
    except OSError as error:
        raise NotifyError("Unable to write the notification state") from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


@contextmanager
def exclusive_state_lock(state_file: Path):
    lock_path = state_file.with_name(f"{state_file.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+b") as lock_file:
        if os.name == "nt":
            import msvcrt
            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def send_report(config: SmtpConfig, report_path: Path, report_id: str, state_file: Path) -> bool:
    try:
        report_bytes = report_path.expanduser().read_bytes()
        report_text = report_bytes.decode("utf-8")
    except (OSError, UnicodeError) as error:
        raise NotifyError("Unable to read the report as UTF-8 text") from error

    report_hash = hashlib.sha256(report_bytes).hexdigest()
    with exclusive_state_lock(state_file):
        state = read_state(state_file)
        if report_id in state:
            if state[report_id] != report_hash:
                raise NotifyError("report-id already used for different report content")
            return False

        message = EmailMessage()
        message["Subject"] = f"Garmin Coach Report {report_id}"
        message["X-Garmin-Report-ID"] = report_id
        message.set_content(report_text, subtype="plain", charset="utf-8")
        send_message(config, message)
        state[report_id] = report_hash
        write_state(state_file, state)
        return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send Garmin coach reports without modifying them")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--test", action="store_true", help="Send an SMTP configuration test")
    mode.add_argument("--report", type=Path, help="UTF-8 report file to send")
    parser.add_argument("--report-id", help="Unique report identifier used for deduplication")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_FILE, help="SMTP env configuration path")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.report_id and not args.report:
        parser.error("--report-id requires --report")
    if args.report and not args.report_id:
        parser.error("--report requires --report-id")

    config: SmtpConfig | None = None
    try:
        config = load_config(args.config)
        if args.test:
            send_test(config)
            print("SMTP test sent")
            return 0
        sent = send_report(config, args.report, args.report_id, state_path())
        print(f"Report {'sent' if sent else 'already sent, skipped'}: {args.report_id}")
        return 0
    except Exception as error:
        secrets = [config.password, config.username] if config else []
        print(f"Error: {sanitize(error, secrets)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
