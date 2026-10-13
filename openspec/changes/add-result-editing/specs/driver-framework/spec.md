## ADDED Requirements

### Requirement: Result column provenance
For SQL drivers, every column of a result SHALL carry, where the driver can know it, the source schema, source table and source column it was read from, and whether the column can be updated through that source (false for computed, aggregated, generated-always and read-only columns). Drivers whose protocol does not report provenance SHALL leave it empty, and Clew SHALL then infer it by analysing the statement (see result-editing › Source detection).

#### Scenario: PostgreSQL reports the table
- **WHEN** a PostgreSQL result column comes straight from `orders.status`
- **THEN** the column metadata names schema `public`, table `orders` and column `status`

#### Scenario: Aliases keep provenance
- **WHEN** a query selects `o.status AS state`
- **THEN** the column is named `state` and its source column is still `status`

#### Scenario: Expressions have no source
- **WHEN** a column is `total * 1.2 AS with_tax`
- **THEN** it has no source table or column and is marked not updatable

#### Scenario: Driver without provenance
- **WHEN** a query runs on a driver that does not report provenance
- **THEN** the columns carry no source and the result editing layer infers it from the statement
