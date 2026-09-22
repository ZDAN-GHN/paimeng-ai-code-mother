DROP TABLE IF EXISTS generation_run;
DROP TABLE IF EXISTS credit_ledger;

DELIMITER $$
CREATE PROCEDURE remove_user_credits_column()
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
            AND table_name = 'user'
            AND column_name = 'credits'
    ) THEN
        ALTER TABLE user DROP COLUMN credits;
    END IF;
END$$
DELIMITER ;

CALL remove_user_credits_column();
DROP PROCEDURE remove_user_credits_column;
