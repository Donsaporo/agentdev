/*
  # Fix agent_secrets masked_value auto-generation

  1. Changes
    - Add trigger function to auto-generate masked_value from secret_value
    - When secret_value is empty, masked_value will also be empty
    - When secret_value has a value, masked_value shows first 4 and last 4 chars with **** in between
    - For short values (8 chars or less), shows just ****
    - Fix existing data: clear masked_value where secret_value is empty

  2. Important Notes
    - The trigger fires on INSERT and UPDATE
    - This ensures masked_value is always in sync with secret_value
*/

CREATE OR REPLACE FUNCTION generate_masked_value()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.secret_value IS NULL OR NEW.secret_value = '' THEN
    NEW.masked_value := '';
  ELSIF length(NEW.secret_value) <= 8 THEN
    NEW.masked_value := '****';
  ELSE
    NEW.masked_value := left(NEW.secret_value, 4) || '****' || right(NEW.secret_value, 4);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_masked_value ON agent_secrets;

CREATE TRIGGER trg_generate_masked_value
  BEFORE INSERT OR UPDATE OF secret_value ON agent_secrets
  FOR EACH ROW
  EXECUTE FUNCTION generate_masked_value();

UPDATE agent_secrets
SET secret_value = secret_value
WHERE secret_value = '' AND masked_value != '';
