from pathlib import Path


def test_ingest_workflow_commits_archives_only():
    path = Path(".github/workflows/ingest.yml")
    content = path.read_text(encoding="utf-8")

    assert 'cron: "0 0 * * *"' in content
    assert "archives/*.gz" in content
    assert "dashboard/db/daily" not in content


def test_ingest_workflow_archive_defaults():
    path = Path(".github/workflows/ingest.yml")
    content = path.read_text(encoding="utf-8")

    assert "ARCHIVE_OLDER_THAN_DAYS" in content
    assert "RETENTION_DAYS" in content
