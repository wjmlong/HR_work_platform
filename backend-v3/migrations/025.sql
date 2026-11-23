-- Keep test deliveries constrained; production deliveries require an explicit
-- confirmed address in the service. No automatic dispatcher is introduced.
ALTER TABLE mailbox_reply_receipts DROP CONSTRAINT mailbox_reply_receipts_test_mode_check;
ALTER TABLE mailbox_reply_receipts DROP CONSTRAINT mailbox_reply_receipts_recipient_check;
ALTER TABLE mailbox_reply_receipts ADD CONSTRAINT mailbox_reply_test_recipient CHECK (NOT test_mode OR recipient='recruiting-operator@example.invalid');
ALTER TABLE mailbox_reply_receipts ADD CONSTRAINT mailbox_reply_single_recipient CHECK (length(recipient)<=254 AND recipient !~ '[[:space:]<>,;]' AND recipient LIKE '%@%.%');
