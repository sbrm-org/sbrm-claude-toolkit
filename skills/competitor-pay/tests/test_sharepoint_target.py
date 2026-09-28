"""Tests for SharePoint target-ID resolution.

This sits on the path of every Graph call, so a wrong answer here points the
migration or the sync at the wrong list.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import sharepoint_target as st  # noqa: E402


# Never assert on the real tenant IDs. They are deliberately not in the
# committed config.json (this is a public repo), so a test that hardcoded them
# would both leak them and fail. Every case below stands up its own config.
COMMITTED = {"site_id": "committed-site", "list_id": "committed-list"}


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPETITOR_PAY_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.delenv("CP_SITE_ID", raising=False)
    monkeypatch.delenv("CP_LIST_ID", raising=False)
    monkeypatch.delenv("CP_ACCOUNT", raising=False)
    fake = tmp_path / "config.json"
    fake.write_text(json.dumps({"sharepoint": dict(COMMITTED)}))
    monkeypatch.setattr(st, "_config_path", lambda: fake)
    return tmp_path / "home"


def _write_local(home, **sharepoint):
    (home / "config.local.json").write_text(json.dumps({"sharepoint": sharepoint}))


class TestPrecedence:
    def test_cli_beats_everything(self, home, monkeypatch):
        monkeypatch.setenv("CP_LIST_ID", "from-env")
        _write_local(home, list_id="from-local")
        assert st.list_id("from-cli") == "from-cli"

    def test_env_beats_local_and_committed(self, home, monkeypatch):
        monkeypatch.setenv("CP_LIST_ID", "from-env")
        _write_local(home, list_id="from-local")
        assert st.list_id() == "from-env"

    def test_local_beats_committed(self, home):
        _write_local(home, list_id="from-local")
        assert st.list_id() == "from-local"

    def test_falls_back_to_committed_config(self, home):
        """With nothing overriding, config.json answers."""
        assert st.list_id() == COMMITTED["list_id"]

    def test_site_and_list_resolve_independently(self, home):
        _write_local(home, list_id="only-list")
        assert st.list_id() == "only-list"
        assert st.site_id() == COMMITTED["site_id"]


class TestPlaceholders:
    def test_placeholder_in_committed_config_is_not_a_value(self, home, tmp_path,
                                                            monkeypatch):
        """This is what makes sanitizing the public repo safe: a placeholder
        must fall through to the local override, not be sent to Graph."""
        fake = tmp_path / "placeholder.json"
        fake.write_text(json.dumps({"sharepoint": {"list_id": "REPLACE_ME"}}))
        monkeypatch.setattr(st, "_config_path", lambda: fake)
        _write_local(home, list_id="real-value")
        assert st.list_id() == "real-value"

    def test_the_real_committed_config_ships_placeholders(self):
        """Guards the public repo: a real tenant ID must never land in git."""
        import importlib
        fresh = importlib.reload(st)
        committed = json.loads(fresh._config_path().read_text())["sharepoint"]
        assert committed["site_id"] == "REPLACE_ME"
        assert committed["list_id"] == "REPLACE_ME"
        assert committed["account"] == "REPLACE_ME"

    def test_empty_cli_value_does_not_win(self, home):
        assert st.list_id("") == COMMITTED["list_id"]

    def test_none_cli_value_does_not_win(self, home):
        assert st.list_id(None) == COMMITTED["list_id"]


class TestMissingConfig:
    def test_malformed_local_config_is_ignored_not_fatal(self, home):
        (home / "config.local.json").write_text("{ not json")
        assert st.list_id() == COMMITTED["list_id"]

    def test_require_explains_how_to_fix(self, home, tmp_path, monkeypatch):
        fake = tmp_path / "empty.json"
        fake.write_text(json.dumps({"sharepoint": {}}))
        monkeypatch.setattr(st, "_config_path", lambda: fake)
        with pytest.raises(SystemExit) as exc:
            st.require("list_id")
        message = str(exc.value)
        assert "CP_LIST_ID" in message
        assert "config.local.json" in message

    def test_require_returns_the_value_when_present(self, home):
        assert st.require("list_id") == COMMITTED["list_id"]


class TestAccount:
    """The Microsoft 365 service account resolves exactly like the IDs.

    It is a real mailbox, so it is configured per install rather than
    committed, and must not pin every install to one tenant.
    """

    def test_cli_beats_env_and_local(self, home, monkeypatch):
        monkeypatch.setenv("CP_ACCOUNT", "env@example.org")
        _write_local(home, account="local@example.org")
        assert st.account("cli@example.org") == "cli@example.org"

    def test_env_beats_local(self, home, monkeypatch):
        monkeypatch.setenv("CP_ACCOUNT", "env@example.org")
        _write_local(home, account="local@example.org")
        assert st.account() == "env@example.org"

    def test_local_config_supplies_it(self, home):
        _write_local(home, list_id="x", account="local@example.org")
        assert st.account() == "local@example.org"

    def test_placeholder_is_not_an_account(self, home, tmp_path, monkeypatch):
        fake = tmp_path / "placeholder.json"
        fake.write_text(json.dumps({"sharepoint": {"account": "REPLACE_ME"}}))
        monkeypatch.setattr(st, "_config_path", lambda: fake)
        assert st.account() is None

    def test_unset_account_is_none(self, home):
        assert st.account() is None

    def test_require_unresolved_account_says_what_to_do(self, home):
        with pytest.raises(SystemExit) as exc:
            st.require("account")
        message = str(exc.value)
        assert message.startswith(
            "ERROR: No service account configured. "
            "Run /comp-setup or set CP_ACCOUNT.")
        assert "config.local.json" in message

    def test_unresolved_account_points_at_local_config_not_committed(
            self, home):
        """The committed config.json is not where an account belongs, so the
        error must not send anyone there."""
        with pytest.raises(SystemExit) as exc:
            st.require("account")
        message = str(exc.value)
        assert "CP_ACCOUNT=" in message
        assert str(st._data_home() / "config.local.json") in message
        assert str(st._config_path()) not in message
        assert "sharepoint.account" not in message

    def test_require_returns_the_configured_account(self, home):
        _write_local(home, account="svc@example.org")
        assert st.require("account") == "svc@example.org"

    def test_shell_entry_point_prints_the_account(self, home, monkeypatch,
                                                  capsys):
        _write_local(home, account="svc@example.org")
        monkeypatch.setattr(sys, "argv", ["sharepoint_target.py", "account"])
        st._main()
        assert capsys.readouterr().out.strip() == "svc@example.org"
