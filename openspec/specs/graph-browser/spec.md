# graph-browser Specification

## Purpose
TBD - created by archiving change add-graph-browser. Update Purpose after archive.
## Requirements
### Requirement: Graph console tab
Opening a console on a Neo4j connection SHALL open a graph console matching `design/canvas/GraphBrowser.dc.html`: breadcrumb (env dot, N4 badge, connection › database), Run (Mod+Enter) and Profile, the environment/access badge (e.g. "STAGING · READ"), a Cypher editor, a result toolbar with views Graph / Table / JSON / Plan and the summary "<n> nodes · <m> relationships · <ms> ms", a graph schema sidebar on the left and an inspector on the right.

#### Scenario: Open a console
- **WHEN** the user opens a console for `staging-neo4j`
- **THEN** the graph console opens with the schema sidebar loaded for the `neo4j` database

#### Scenario: Switch database
- **WHEN** the user picks another database from the breadcrumb menu
- **THEN** the session switches database and the schema sidebar reloads

### Requirement: Cypher editor
The Cypher editor SHALL provide syntax highlighting (keywords `--syn-keyword`, labels and relationship types `--syn-function`, strings, numbers, comments), completion of labels, relationship types, property keys, functions and procedures from the live schema, statement detection by `;`, and query parameters (`$name`) set in a Parameters panel as JSON.

#### Scenario: Complete a label
- **WHEN** the user types `(u:Us`
- **THEN** the completion popup offers `User` with its node count

#### Scenario: Missing parameter
- **WHEN** the query uses `$name` and no parameter `name` is set
- **THEN** running shows "Set a value for $name" and focuses the Parameters panel

### Requirement: Graph view
The Graph view SHALL render the distinct nodes and relationships of the result as a force-directed graph: nodes as circles colored per label (stable colors from the token palette, legend chips with counts), captioned by a chosen property (default `name`, then `title`, then the first string property, then the id); relationships as lines labelled with their type. The view SHALL support pan, zoom (buttons, wheel, pinch), fit to screen, dragging nodes (which pins them), selecting nodes and relationships, double-click to expand neighbours, and hiding nodes.

#### Scenario: Expand neighbours
- **WHEN** the user double-clicks `Brass Lamp`
- **THEN** a read query fetches its neighbours (up to 25) and they animate into the graph

#### Scenario: Too many nodes
- **WHEN** a result has more than 300 distinct nodes
- **THEN** the first 300 are drawn with the notice "Showing 300 of <n> nodes — Show all / Use Table view"

#### Scenario: No graph values
- **WHEN** a query returns only scalars (e.g. `RETURN count(*)`)
- **THEN** the result opens in the Table view and the Graph view is disabled with "No nodes or relationships in this result"

#### Scenario: Keyboard access
- **WHEN** focus is in the graph and the user presses Tab
- **THEN** focus moves through nodes in a stable order, Enter selects, and the inspector announces the selection

### Requirement: Table, JSON and Plan views
The Table view SHALL show one row per record with one column per returned variable (nodes and relationships shown as `(:Label {name})` / `[:TYPE]` summaries that open in the inspector). JSON SHALL show the records as JSON. Plan SHALL show the EXPLAIN or PROFILE plan as an operator tree with estimated rows, and for PROFILE, actual rows and db hits.

#### Scenario: Profile
- **WHEN** the user clicks Profile
- **THEN** the query runs with PROFILE and the Plan view shows db hits per operator, highest first highlighted

### Requirement: Graph schema sidebar
The sidebar SHALL list NODE LABELS (colored chips with counts), RELATIONSHIP TYPES, PROPERTY KEYS and INDEXES & CONSTRAINTS. Clicking a label SHALL run `MATCH (n:<Label>) RETURN n LIMIT 25`; clicking a relationship type SHALL run `MATCH p=()-[:<TYPE>]->() RETURN p LIMIT 25` (both inserted into the editor first, so the user sees what runs).

#### Scenario: Click a label
- **WHEN** the user clicks `Product` in NODE LABELS
- **THEN** the editor shows `MATCH (n:Product) RETURN n LIMIT 25` and its results appear

### Requirement: Inspector
Selecting a node or relationship SHALL show it in the inspector: label/type chip, element id, properties with typed colors, and for nodes the relationship counts by type and direction, plus actions Expand neighbours, Hide node, Copy as Cypher MATCH, and (when the session is writable) Edit properties.

#### Scenario: Edit a property
- **WHEN** the user edits `plan` on a node in a writable session and saves
- **THEN** a parameterised `MATCH (n) WHERE elementId(n) = $id SET n.plan = $value` runs after the safeguards confirmation for the connection's environment

### Requirement: Cypher safeguards
The statement classifier SHALL treat Cypher as `write` when it contains CREATE, MERGE, SET, DELETE, DETACH DELETE, REMOVE, LOAD CSV, FOREACH with updates, or schema/admin commands (CREATE/DROP INDEX, CONSTRAINT, DATABASE), and as `read` otherwise; `CALL` of procedures not known to be read-only SHALL count as `unknown`. A `DETACH DELETE` or `DELETE` whose MATCH has no label, property or WHERE filter SHALL be a dangerous statement. Read-only sessions SHALL run every transaction in READ access mode.

#### Scenario: Delete everything on production
- **WHEN** the user runs `MATCH (n) DETACH DELETE n` on a production Neo4j connection
- **THEN** the type-the-connection-name confirmation is required

#### Scenario: Read procedure
- **WHEN** the user runs `CALL db.labels()`
- **THEN** it is classified as `read` and runs without confirmation

### Requirement: Explorer, palette and AI integration
For Neo4j connections the explorer SHALL show databases → Node labels / Relationship types / Indexes; the command palette SHALL index labels and relationship types; the AI assistant SHALL use the `cypher` dialect and send the graph schema (labels, relationship types, property keys and their types; never node data unless attached) as context.

#### Scenario: Palette
- **WHEN** the user searches "Prod" in the command palette
- **THEN** the `Product` label of `staging-neo4j` appears and opening it runs the label query in a graph console
