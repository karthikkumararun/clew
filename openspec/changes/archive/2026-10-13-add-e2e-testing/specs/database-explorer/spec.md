## ADDED Requirements

### Requirement: Default grouping by environment
While the user has created no groups of their own, the explorer SHALL group connections under the headers PRODUCTION, STAGING, DEVELOPMENT and LOCAL, in that order, placing each connection under the header of its environment and hiding headers that would be empty. As soon as the user creates a group, the user's groups SHALL be used instead, and connections without a group appear under "Ungrouped".

#### Scenario: All four environments
- **WHEN** there are connections in Production, Staging, Development and Local and no user-created groups
- **THEN** the explorer shows four headers in the order PRODUCTION, STAGING, DEVELOPMENT, LOCAL, each with its connections

#### Scenario: Empty headers are hidden
- **WHEN** there are only Production and Local connections
- **THEN** only PRODUCTION and LOCAL headers appear

#### Scenario: Environment change moves the connection
- **WHEN** the user changes a connection's environment from Local to Staging
- **THEN** it moves under the STAGING header

#### Scenario: User creates a group
- **WHEN** the user creates a group called "Client A" and moves a connection into it
- **THEN** the explorer switches to the user's groups, showing "Client A" and "Ungrouped" with the remaining connections, and no environment headers
