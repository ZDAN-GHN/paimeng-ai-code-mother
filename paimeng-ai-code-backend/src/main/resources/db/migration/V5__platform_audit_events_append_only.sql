CREATE TRIGGER platform_application_lifecycle_event_no_update
BEFORE UPDATE ON platform_application_lifecycle_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_application_lifecycle_event is append-only';

CREATE TRIGGER platform_application_lifecycle_event_no_delete
BEFORE DELETE ON platform_application_lifecycle_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_application_lifecycle_event is append-only';

CREATE TRIGGER platform_task_transition_event_no_update
BEFORE UPDATE ON platform_task_transition_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_task_transition_event is append-only';

CREATE TRIGGER platform_task_transition_event_no_delete
BEFORE DELETE ON platform_task_transition_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_task_transition_event is append-only';

CREATE TRIGGER platform_run_transition_event_no_update
BEFORE UPDATE ON platform_run_transition_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_run_transition_event is append-only';

CREATE TRIGGER platform_run_transition_event_no_delete
BEFORE DELETE ON platform_run_transition_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_run_transition_event is append-only';
