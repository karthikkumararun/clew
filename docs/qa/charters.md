# Exploratory charters

Short missions for manual passes. Each has a time box and what to record. Record findings as
defects (see `README.md`). When a pass finds something no charter would have found, add a
charter that would have, in the same pull request as the fix.

1. **Get back from everywhere** (20 min). Hide or close every panel (sidebar, side panel, results
   panel, record panel) at the widest and narrowest window. Record any state with no visible way
   back, and what restored it.
2. **Narrowest window, every menu** (20 min). Resize to the minimum size and open every menu,
   popover and dialog. Record anything clipped, off-screen or covered.
3. **Every saved layout** (20 min). Quit with each combination of panels shown and hidden, tabs
   overflowing and the explorer collapsed; start again each time. Record states that do not
   restore.
4. **Environments everywhere** (15 min). Change a connection between local, staging and
   production and watch every place that shows the environment (stripe, chip, tab, status bar,
   explorer). Record places that disagree.
5. **Production end to end** (30 min). On a production connection: write attempts, confirmation
   dialogs, manual commit, quit with an open transaction. Record any path that writes without
   asking.
6. **Pull the plug** (20 min). Kill the database, or the network, in the middle of a query, an
   export, a table-editor submit and a connect. Record hangs, lost data and unclear messages.
7. **Keyboard only** (15 min). Do a whole task without the mouse: connect, query, edit a cell,
   export. Record unreachable controls and missing focus rings.
8. **Canvas comparison** (30 min). Compare every screen with its canvas image in
   `design/canvas/` and `design/screens/`. Record differences in layout, copy, colour and
   states.
9. **Bring your own data** (20 min). Import connections from a tool you use (DataGrip). Record
   what did not come across and what was wrong.
