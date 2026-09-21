CREATE TRIGGER platform_requirement_immutable
BEFORE UPDATE ON platform_requirement
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_requirement is immutable';
