"""
Team Storage — persistent team save/load backed by JSON files.

Each team is stored as a JSON file in TEAMS_DIR with schema:
{
  "team_name": str,
  "created": ISO timestamp,
  "modified": ISO timestamp,
  "sets": [str, ...]   # list of set IDs (up to 6)
}
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, field

from pokeredus.config import TEAMS_DIR


@dataclass
class TeamRecord:
    """Metadata + data for a saved team."""
    team_id: str        # filename stem (unique key)
    team_name: str
    created: str        # ISO timestamp
    modified: str       # ISO timestamp
    sets: list[str] = field(default_factory=list)

    @property
    def pokemon_count(self) -> int:
        return len(self.sets)

    def to_dict(self) -> dict:
        return {
            "team_name": self.team_name,
            "created": self.created,
            "modified": self.modified,
            "sets": self.sets,
        }

    @classmethod
    def from_dict(cls, team_id: str, data: dict) -> TeamRecord:
        return cls(
            team_id=team_id,
            team_name=data.get("team_name", team_id),
            created=data.get("created", ""),
            modified=data.get("modified", ""),
            sets=data.get("sets", []),
        )


class TeamStore:
    """Manages persistent team storage backed by JSON files on disk."""

    def __init__(self, base_dir: Path | None = None):
        self._dir = base_dir or TEAMS_DIR
        self._dir.mkdir(parents=True, exist_ok=True)

    @property
    def store_dir(self) -> Path:
        return self._dir

    # ── CRUD ────────────────────────────────────────────────────────

    def list_teams(self) -> list[TeamRecord]:
        """Return all saved teams sorted by modified date (newest first)."""
        records: list[TeamRecord] = []
        for path in sorted(self._dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                records.append(TeamRecord.from_dict(path.stem, data))
            except (json.JSONDecodeError, OSError):
                continue
        records.sort(key=lambda r: r.modified, reverse=True)
        return records

    def get_team(self, team_id: str) -> TeamRecord | None:
        """Load a single team by ID."""
        path = self._dir / f"{team_id}.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return TeamRecord.from_dict(team_id, data)
        except (json.JSONDecodeError, OSError):
            return None

    def save_team(self, record: TeamRecord) -> None:
        """Save a team record to disk."""
        path = self._dir / f"{record.team_id}.json"
        path.write_text(
            json.dumps(record.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def create_team(self, team_name: str, set_ids: list[str] | None = None) -> TeamRecord:
        """Create a new team with a unique ID and save it."""
        now = datetime.now(timezone.utc).isoformat()
        team_id = self._make_id(team_name)
        record = TeamRecord(
            team_id=team_id,
            team_name=team_name,
            created=now,
            modified=now,
            sets=set_ids or [],
        )
        self.save_team(record)
        return record

    def update_team(self, team_id: str, team_name: str | None = None,
                    set_ids: list[str] | None = None) -> TeamRecord | None:
        """Update an existing team's name and/or sets."""
        record = self.get_team(team_id)
        if record is None:
            return None
        if team_name is not None:
            record.team_name = team_name
        if set_ids is not None:
            record.sets = set_ids
        record.modified = datetime.now(timezone.utc).isoformat()
        self.save_team(record)
        return record

    def delete_team(self, team_id: str) -> bool:
        """Delete a team by ID. Returns True if deleted."""
        path = self._dir / f"{team_id}.json"
        if path.exists():
            path.unlink()
            return True
        return False

    # ── Helpers ─────────────────────────────────────────────────────

    def _make_id(self, name: str) -> str:
        """Generate a unique team ID from the name."""
        base = name.strip().lower().replace(" ", "_")
        # Strip non-alphanumeric except underscore
        base = "".join(c for c in base if c.isalnum() or c == "_") or "team"
        candidate = base
        counter = 1
        while (self._dir / f"{candidate}.json").exists():
            counter += 1
            candidate = f"{base}_{counter}"
        return candidate
