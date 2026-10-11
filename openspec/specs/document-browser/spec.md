# document-browser Specification

## Purpose
TBD - created by archiving change add-nosql-browser. Update Purpose after archive.
## Requirements

### Requirement: Collection tab
Opening a MongoDB collection SHALL open a tab matching `design/canvas/MongoBrowser.dc.html`: breadcrumb (env dot, MG badge, connection › database › **collection**), views Documents / Inferred schema / Indexes / Aggregation, "Open in shell console", and a side list of the database's collections with document counts.

#### Scenario: Open a collection
- **WHEN** the user double-clicks `events` in the explorer
- **THEN** a tab opens on Documents showing the first 50 documents sorted by `_id` descending

### Requirement: Query bar
The Documents view SHALL have FILTER, PROJECT, SORT and LIMIT fields accepting relaxed shell syntax (unquoted keys, single quotes, `ObjectId()`, `ISODate()`, `NumberLong()`, regex literals) and a Find button (Mod+Enter). The toolbar SHALL show "<n> of <total> matched · <ms> ms · index <name>" (index from the winning plan, or "COLLSCAN" in `--warning`).

#### Scenario: Relaxed syntax
- **WHEN** the filter is `{ type: "checkout", ts: { $gte: ISODate("2026-10-01") } }`
- **THEN** it parses to the equivalent BSON filter and the results load

#### Scenario: Invalid filter
- **WHEN** the filter cannot be parsed
- **THEN** the field shows the parse error with its position and the previous results remain

#### Scenario: Collection scan warning
- **WHEN** the query uses no index on a collection over 100k documents
- **THEN** the toolbar shows "COLLSCAN" in the warning color

### Requirement: Tree, table and JSON views
The results SHALL be viewable as a Tree (columns Key / Value / Type; documents expandable to any depth with "{ n fields }" and "[ n elements ]" summaries and type-colored values), a Table (top-level fields as columns, nested values summarized), or JSON (Extended JSON, read-only, with folding).

#### Scenario: Expand nested
- **WHEN** the user expands `items` in the tree
- **THEN** each array element appears indented with its index as the key

### Requirement: Edit documents
The user SHALL be able to edit a value in the tree (double-click; type-aware), add or remove fields, edit a whole document as JSON, insert a document and delete documents. Edits to one document SHALL be saved with Mod+S as a `replaceOne` (or `updateOne` with `$set`/`$unset` for field edits) guarded by the original document's `_id` and version check; safeguards from `production-safeguards` apply.

#### Scenario: Change a field type
- **WHEN** the user changes `user.id` from Int32 `1042` to the string `"1042"` via the type menu
- **THEN** the pending change shows the new type, and saving writes a string

#### Scenario: Concurrent modification
- **WHEN** the document changed in the database since it was loaded
- **THEN** saving reports the conflict and offers Reload or Overwrite

### Requirement: Inferred schema and indexes
Inferred schema SHALL sample up to 1,000 documents and list each field path with its observed types and frequency. Indexes SHALL list name, keys, unique/sparse/TTL options and size, with create and drop (drop requires confirmation).

#### Scenario: Mixed types
- **WHEN** `coupon` is a string in 30% of documents and missing in 70%
- **THEN** the schema shows `coupon` with "String · 30%"

### Requirement: Shell console for MongoDB
A console tab on a MongoDB connection SHALL accept shell-style commands (`db.<coll>.find/findOne/aggregate/countDocuments/distinct/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany`, `show collections`, `use <db>`) and show results in the tree/table/JSON views. Arbitrary JavaScript SHALL NOT be executed.

#### Scenario: Aggregate
- **WHEN** the user runs `db.events.aggregate([{ $group: { _id: "$type", n: { $sum: 1 } } }])`
- **THEN** the grouped results appear

#### Scenario: Unsupported JavaScript
- **WHEN** the user writes a `for` loop
- **THEN** the console reports "Only db.<collection>.<method>(…) commands are supported"

### Requirement: Export documents
The user SHALL export the current query's results (all matches, streamed) to JSON (array or lines, Extended JSON) or CSV (flattened dot paths).

#### Scenario: Export as JSON lines
- **WHEN** the user exports 1,936 matches as JSON lines
- **THEN** the file has 1,936 lines, each a valid Extended JSON document
