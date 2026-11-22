from collections.abc import Generator
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy import event

from app.config import settings

sqlite_url = f"sqlite:///{settings.db_path}"

engine = create_engine(
    sqlite_url,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, _connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA foreign_keys=ON;")
    cursor.close()


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        cols = conn.exec_driver_sql("PRAGMA table_info(workflows)").fetchall()
        col_names = {row[1] for row in cols}
        if "output_node_ids_json" not in col_names:
            conn.exec_driver_sql(
                "ALTER TABLE workflows ADD COLUMN output_node_ids_json TEXT NOT NULL DEFAULT '[]'"
            )
        if "raw_workflow_json" not in col_names:
            conn.exec_driver_sql(
                "ALTER TABLE workflows ADD COLUMN raw_workflow_json TEXT"
            )
        if "source_filename" not in col_names:
            conn.exec_driver_sql(
                "ALTER TABLE workflows ADD COLUMN source_filename TEXT NOT NULL DEFAULT ''"
            )
        gen_cols = conn.exec_driver_sql("PRAGMA table_info(generations)").fetchall()
        gen_col_names = {row[1] for row in gen_cols}
        if "input_media_json" not in gen_col_names:
            conn.exec_driver_sql(
                "ALTER TABLE generations ADD COLUMN input_media_json TEXT NOT NULL DEFAULT '[]'"
            )


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session
