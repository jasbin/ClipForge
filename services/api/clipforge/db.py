"""SQLite (SQLModel) tables. Kept Postgres-compatible: JSON lives in text columns."""

import uuid
from datetime import datetime, timezone

from sqlmodel import Field, Session, SQLModel, create_engine

from . import config


def _id() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Project(SQLModel, table=True):
    id: str = Field(default_factory=_id, primary_key=True)
    title: str
    source_url: str | None = None
    source_path: str | None = None
    duration: float | None = None
    status: str = "queued"  # queued | running | done | error
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    settings_json: str = "{}"
    created_at: datetime = Field(default_factory=_now)


class Transcript(SQLModel, table=True):
    project_id: str = Field(primary_key=True, foreign_key="project.id")
    language: str
    words_json: str
    sentences_json: str


class Clip(SQLModel, table=True):
    id: str = Field(default_factory=_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="project.id")
    rank: int
    start: float
    end: float
    title: str
    hook: str
    reason: str
    missing_context: str = ""
    scores_json: str
    virality: float
    text: str
    reframe_json: str | None = None
    caption_style_json: str | None = None
    status: str = "found"  # found | rendering | rendered
    output_path: str | None = None
    feedback: int | None = None  # +1 / -1
    # AI voiceover (Qwen3-TTS): none | queued | running | done | error
    voice_status: str = "none"
    voice_progress: float = 0.0
    voice_error: str | None = None
    voice_path: str | None = None
    # Narration script for "Rewrite with AI": JSON {"direction": str, "lines": [ScriptLine]}
    script_json: str | None = None


class Job(SQLModel, table=True):
    id: str = Field(default_factory=_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="project.id")
    clip_id: str | None = None
    kind: str  # find | voiceover
    params_json: str | None = None
    status: str = "queued"  # queued | running | done | error
    attempts: int = 0
    error: str | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


engine = create_engine(config.DB_URL, connect_args={"check_same_thread": False, "timeout": 30})


# Columns added after the first release; create_all() won't add them to existing tables.
_MIGRATIONS = {
    "clip": {
        "voice_status": "VARCHAR NOT NULL DEFAULT 'none'",
        "voice_progress": "FLOAT NOT NULL DEFAULT 0",
        "voice_error": "VARCHAR",
        "voice_path": "VARCHAR",
        "script_json": "VARCHAR",
    },
    "job": {"params_json": "VARCHAR"},
}


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL")  # API reads while the worker writes
        for table, columns in _MIGRATIONS.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def session() -> Session:
    return Session(engine)
