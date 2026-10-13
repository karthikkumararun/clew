//! The `plan` (EXPLAIN) or `profile` (PROFILE) map of a result summary as an operator tree.

use super::bolt::Ps;
use crate::drivers::graph::PlanNode;

/// Operators carry their database as a suffix (`Expand(All)@neo4j`).
fn operator_name(raw: &str) -> String {
    raw.split('@').next().unwrap_or(raw).to_string()
}

fn number(ps: Option<&Ps>) -> Option<f64> {
    ps.and_then(Ps::as_f64)
}

fn convert(op: &Ps, depth: usize) -> PlanNode {
    let args = op.get("args");
    let arg = |name: &str| args.and_then(|a| a.get(name));
    let rows = op.get("rows").or_else(|| arg("Rows")).and_then(Ps::as_i64);
    let db_hits = op
        .get("dbHits")
        .or_else(|| arg("DbHits"))
        .and_then(Ps::as_i64);
    let details = arg("Details")
        .and_then(Ps::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    // a plan nested deeper than any real query is cut off rather than followed
    let children = if depth < 200 {
        op.get("children")
            .and_then(Ps::as_list)
            .unwrap_or_default()
            .iter()
            .map(|c| convert(c, depth + 1))
            .collect()
    } else {
        Vec::new()
    };
    PlanNode {
        operator: operator_name(
            op.get("operatorType")
                .and_then(Ps::as_str)
                .unwrap_or("Unknown"),
        ),
        details,
        estimated_rows: number(arg("EstimatedRows")),
        rows,
        db_hits,
        children,
    }
}

/// The plan of a result summary: PROFILE's tree when present, else EXPLAIN's.
pub fn plan_of(summary: &Ps) -> Option<PlanNode> {
    let root = summary.get("profile").or_else(|| summary.get("plan"))?;
    root.as_map()?;
    Some(convert(root, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(name: &str, args: Vec<(&str, Ps)>, children: Vec<Ps>) -> Ps {
        Ps::map([
            ("operatorType", Ps::str(name)),
            ("args", Ps::map(args)),
            ("identifiers", Ps::List(vec![])),
            ("children", Ps::List(children)),
        ])
    }

    /// (spec: graph-browser › Table, JSON and Plan views › Profile)
    #[test]
    fn a_profile_carries_rows_and_db_hits_per_operator() {
        let leaf = Ps::map([
            ("operatorType", Ps::str("NodeByLabelScan@neo4j")),
            (
                "args",
                Ps::map([
                    ("Details", Ps::str("u:User")),
                    ("EstimatedRows", Ps::Float(5.0)),
                ]),
            ),
            ("children", Ps::List(vec![])),
            ("dbHits", Ps::Int(6)),
            ("rows", Ps::Int(5)),
        ]);
        let root = Ps::map([
            ("operatorType", Ps::str("ProduceResults@neo4j")),
            ("args", Ps::map([("Details", Ps::str("u"))])),
            ("children", Ps::List(vec![leaf])),
            ("dbHits", Ps::Int(0)),
            ("rows", Ps::Int(5)),
        ]);
        let plan = plan_of(&Ps::map([("profile", root)])).unwrap();
        assert_eq!(plan.operator, "ProduceResults");
        assert_eq!(plan.rows, Some(5));
        let scan = &plan.children[0];
        assert_eq!(scan.operator, "NodeByLabelScan");
        assert_eq!(scan.details, "u:User");
        assert_eq!(scan.estimated_rows, Some(5.0));
        assert_eq!((scan.rows, scan.db_hits), (Some(5), Some(6)));
    }

    #[test]
    fn an_explain_plan_has_estimates_only() {
        let plan = plan_of(&Ps::map([(
            "plan",
            op(
                "ProduceResults@neo4j",
                vec![("EstimatedRows", Ps::Float(12.0))],
                vec![op(
                    "AllNodesScan@neo4j",
                    vec![("EstimatedRows", Ps::Int(12))],
                    vec![],
                )],
            ),
        )]))
        .unwrap();
        assert_eq!(plan.estimated_rows, Some(12.0));
        assert_eq!(plan.rows, None);
        assert_eq!(plan.db_hits, None);
        assert_eq!(plan.children[0].estimated_rows, Some(12.0));
    }

    #[test]
    fn rows_and_db_hits_may_sit_in_the_arguments() {
        let plan = plan_of(&Ps::map([(
            "profile",
            op(
                "Filter",
                vec![("Rows", Ps::Int(3)), ("DbHits", Ps::Int(9))],
                vec![],
            ),
        )]))
        .unwrap();
        assert_eq!((plan.rows, plan.db_hits), (Some(3), Some(9)));
    }

    #[test]
    fn no_plan_in_the_summary_is_none() {
        assert!(plan_of(&Ps::map([("db", Ps::str("neo4j"))])).is_none());
        assert!(plan_of(&Ps::Null).is_none());
    }
}
