-- What to call the visitor (asked at sign-up, editable in the settings), so
-- the app and its emails can address them by name. Nullable: accounts made
-- before this have none until they add one.
ALTER TABLE users ADD COLUMN name text;
