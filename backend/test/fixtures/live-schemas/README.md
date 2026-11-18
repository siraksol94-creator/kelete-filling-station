# Live schema fixtures (Phase 2a)

Put the schema-only `.sql` files extracted from the VPS and the station tills here
(`sqlite3 -readonly copy.db .schema > file.sql`). Never `.dump` — no business data.
Each file becomes a test: the database it describes must upgrade cleanly and a
second start must change nothing.
