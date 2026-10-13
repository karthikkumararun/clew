## ADDED Requirements

### Requirement: Transaction isolation level
The console toolbar's transaction control SHALL show the isolation level in manual mode ("Tx: Manual · READ COMMITTED") and its menu SHALL list the levels the driver supports and Auto-commit or Manual. Choosing a level applies to the next transaction, or immediately when no transaction is open; changing it while a transaction is open SHALL ask to commit or roll back first. Each connection MAY have a default level in its Advanced settings, used by new sessions.

#### Scenario: Choose a level
- **WHEN** the user picks SERIALIZABLE from the Tx menu in a manual console with no open transaction
- **THEN** the chip reads "Tx: Manual · SERIALIZABLE" and the next transaction uses it

#### Scenario: Change inside a transaction
- **WHEN** the user picks another level while a transaction is open
- **THEN** a dialog offers Commit, Roll back and Cancel before the change applies

#### Scenario: Connection default
- **WHEN** a connection's default is REPEATABLE READ
- **THEN** every new console session of that connection starts with it
