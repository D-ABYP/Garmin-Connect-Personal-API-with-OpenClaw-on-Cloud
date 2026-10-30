import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

from scripts import notify_email


FAKE_PASSWORD = "fake-smtp-password-not-a-real-secret"


class FakeSmtp:
    instances = []
    ssl_instances = []
    login_error = None

    def __init__(self, host, port, timeout):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.started_tls = False
        self.logged_in = None
        self.messages = []
        type(self).instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def starttls(self):
        self.started_tls = True

    def login(self, username, password):
        self.logged_in = (username, password)
        if type(self).login_error:
            raise type(self).login_error

    def send_message(self, message):
        self.messages.append(message)


class FakeSmtpSsl(FakeSmtp):
    instances = []
    ssl_instances = []

    def __init__(self, host, port, timeout):
        super().__init__(host, port, timeout)
        type(self).ssl_instances.append(self)


class NotifyEmailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="garmin-notify-test-")
        self.root = Path(self.temp.name)
        self.config = self.root / "email.env"
        self.state = self.root / "notify-state.json"
        self.report = self.root / "report.md"
        self.report.write_text("# Morning report\n\nActual test content.\n", encoding="utf-8")
        self.config.write_text(
            "\n".join([
                "SMTP_HOST=smtp.example.invalid",
                "SMTP_PORT=587",
                "SMTP_USERNAME=fake-user",
                f"SMTP_PASSWORD={FAKE_PASSWORD}",
                "SMTP_FROM=coach@example.invalid",
                "SMTP_TO=athlete@example.invalid",
                "SMTP_SECURITY=starttls",
                "SMTP_TIMEOUT=12",
            ]),
            encoding="utf-8",
        )
        FakeSmtp.instances = []
        FakeSmtpSsl.ssl_instances = []
        FakeSmtp.login_error = None
        self.patches = [
            mock.patch.object(notify_email.smtplib, "SMTP", FakeSmtp),
            mock.patch.object(notify_email.smtplib, "SMTP_SSL", FakeSmtpSsl),
        ]
        for patch in self.patches:
            patch.start()
        self.old_state = os.environ.get("GARMIN_NOTIFY_STATE_FILE")
        os.environ["GARMIN_NOTIFY_STATE_FILE"] = str(self.state)

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        if self.old_state is None:
            os.environ.pop("GARMIN_NOTIFY_STATE_FILE", None)
        else:
            os.environ["GARMIN_NOTIFY_STATE_FILE"] = self.old_state
        self.temp.cleanup()

    def test_test_mode_uses_starttls_without_printing_password(self):
        stderr = io.StringIO()
        with mock.patch("sys.stderr", stderr):
            result = notify_email.main(["--test", "--config", str(self.config)])

        self.assertEqual(result, 0)
        smtp = FakeSmtp.instances[0]
        self.assertTrue(smtp.started_tls)
        self.assertEqual(smtp.logged_in, ("fake-user", FAKE_PASSWORD))
        self.assertEqual(smtp.messages[0]["Subject"], "Garmin Coach SMTP test")
        self.assertNotIn(FAKE_PASSWORD, stderr.getvalue())

    def test_ssl_mode_uses_smtp_ssl(self):
        self.config.write_text(self.config.read_text(encoding="utf-8").replace("starttls", "ssl"), encoding="utf-8")

        result = notify_email.main(["--test", "--config", str(self.config)])

        self.assertEqual(result, 0)
        self.assertEqual(len(FakeSmtpSsl.ssl_instances), 1)
        self.assertFalse(FakeSmtpSsl.ssl_instances[0].started_tls)

    def test_report_is_sent_unchanged_and_duplicate_id_is_skipped(self):
        before = hashlib.sha256(self.report.read_bytes()).hexdigest()
        args = ["--report", str(self.report), "--report-id", "morning-2026-10-30", "--config", str(self.config)]

        self.assertEqual(notify_email.main(args), 0)
        self.assertEqual(notify_email.main(args), 0)

        self.assertEqual(hashlib.sha256(self.report.read_bytes()).hexdigest(), before)
        self.assertEqual(self.report.read_text(encoding="utf-8"), "# Morning report\n\nActual test content.\n")
        self.assertEqual(len(FakeSmtp.instances), 1)
        self.assertIn("morning-2026-10-30", FakeSmtp.instances[0].messages[0]["Subject"])
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(state["morning-2026-10-30"], before)

    def test_same_id_with_different_report_is_rejected(self):
        args = ["--report", str(self.report), "--report-id", "daily-report", "--config", str(self.config)]
        self.assertEqual(notify_email.main(args), 0)
        self.report.write_text("different content", encoding="utf-8")

        stderr = io.StringIO()
        with mock.patch("sys.stderr", stderr):
            result = notify_email.main(args)

        self.assertEqual(result, 1)
        self.assertEqual(len(FakeSmtp.instances), 1)
        self.assertIn("already used", stderr.getvalue())

    def test_concurrent_senders_emit_only_one_message_for_the_same_id(self):
        args = ["--report", str(self.report), "--report-id", "concurrent-report", "--config", str(self.config)]
        original_send = notify_email.send_message

        def slow_send(config, message):
            time.sleep(0.05)
            return original_send(config, message)

        with mock.patch.object(notify_email, "send_message", slow_send):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: notify_email.main(args), range(2)))

        self.assertEqual(results, [0, 0])
        self.assertEqual(len(FakeSmtp.instances), 1)

    def test_smtp_error_is_sanitized(self):
        FakeSmtp.login_error = notify_email.smtplib.SMTPAuthenticationError(535, FAKE_PASSWORD.encode())
        stderr = io.StringIO()

        with mock.patch("sys.stderr", stderr):
            result = notify_email.main(["--test", "--config", str(self.config)])

        self.assertEqual(result, 1)
        self.assertNotIn(FAKE_PASSWORD, stderr.getvalue())
        self.assertIn("SMTP", stderr.getvalue())

    def test_missing_password_does_not_dump_configuration(self):
        self.config.write_text(self.config.read_text(encoding="utf-8").replace(f"SMTP_PASSWORD={FAKE_PASSWORD}\n", ""), encoding="utf-8")
        stderr = io.StringIO()

        with mock.patch("sys.stderr", stderr):
            result = notify_email.main(["--test", "--config", str(self.config)])

        self.assertEqual(result, 1)
        self.assertNotIn("fake-user", stderr.getvalue())
        self.assertNotIn(FAKE_PASSWORD, stderr.getvalue())

    def test_report_id_requires_report(self):
        stderr = io.StringIO()
        with mock.patch("sys.stderr", stderr), self.assertRaises(SystemExit) as raised:
            notify_email.main(["--report-id", "orphan", "--config", str(self.config)])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
