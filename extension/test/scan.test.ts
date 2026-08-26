/**
 * Tests for the generic reference walk.
 *
 * The fixtures are hand-built to the exact shapes in
 * `@mendix/extensions-api@0.11.0-mendix.11.12.0`'s `index.d.ts` — `Microflows$ActionActivity`
 * wrapping a `Microflows$MicroflowCallAction` whose `microflowCall.microflow` is the callee, and so
 * on. The point of testing against shapes rather than a live model is that the walk's whole claim
 * is "one rule covers 35 reference sites", and that claim is checkable offline.
 */

import { describe, expect, it } from "vitest";

import { collectReferences } from "../src/graph/scan.js";

const KNOWN = new Set([
    "Sales.SUB_A",
    "Sales.SUB_B",
    "Sales.SUB_C",
    "Sales.ACT_Entry",
    "Sales.SUB_OnError",
    "Billing.SUB_Invoice"
]);
const resolves = (name: string): boolean => KNOWN.has(name);

/** A microflow object, i.e. something drawn on the canvas. `relativeMiddlePoint` marks it as such. */
function activity(id: string, action: unknown): unknown {
    return {
        $Type: "Microflows$ActionActivity",
        $ID: id,
        relativeMiddlePoint: { x: 0, y: 0 },
        size: { width: 120, height: 30 },
        caption: "",
        action
    };
}

function microflowCallAction(target: string): unknown {
    return {
        $Type: "Microflows$MicroflowCallAction",
        $ID: "action-" + target,
        microflowCall: {
            $Type: "Microflows$MicroflowCall",
            $ID: "call-" + target,
            microflow: target,
            parameterMappings: [],
            queueSettings: null
        },
        outputVariableName: "",
        useReturnVariable: false
    };
}

function microflow(objects: unknown[], extra: Record<string, unknown> = {}): unknown {
    return {
        $Type: "Microflows$Microflow",
        $ID: "unit-1",
        markAsUsed: false,
        flows: [],
        objectCollection: { $Type: "Microflows$MicroflowObjectCollection", objects },
        ...extra
    };
}

describe("collectReferences", () => {
    it("finds a direct microflow call and attaches the activity id", () => {
        const unit = microflow([activity("act-1", microflowCallAction("Sales.SUB_B"))]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            from: "Sales.SUB_A",
            to: "Sales.SUB_B",
            // The ActionActivity, not the inner MicroflowCall - that is what the editor can focus.
            viaElementId: "act-1",
            viaType: "Microflows$MicroflowCall"
        });
        expect(edges[0]?.path).toBe("objectCollection.objects[0].action.microflowCall.microflow");
    });

    it("descends into a loop's nested object collection", () => {
        const unit = microflow([
            {
                $Type: "Microflows$LoopedActivity",
                $ID: "loop-1",
                relativeMiddlePoint: { x: 0, y: 0 },
                size: { width: 200, height: 200 },
                objectCollection: {
                    $Type: "Microflows$MicroflowObjectCollection",
                    objects: [activity("act-inner", microflowCallAction("Sales.SUB_C"))]
                }
            }
        ]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]?.to).toBe("Sales.SUB_C");
        // The innermost drawable ancestor wins, so a click lands on the activity, not the loop.
        expect(edges[0]?.viaElementId).toBe("act-inner");
    });

    it("finds calls on a custom error handler path", () => {
        const unit = microflow([
            activity("act-happy", microflowCallAction("Sales.SUB_B")),
            {
                ...(activity("act-error", microflowCallAction("Sales.SUB_OnError")) as object),
                errorHandlingType: "Custom"
            }
        ]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges.map(edge => edge.to).sort()).toEqual(["Sales.SUB_B", "Sales.SUB_OnError"]);
    });

    it("finds a microflow passed as a Java action parameter", () => {
        // This is how a Core.execute target gets wired declaratively, and it is exactly the case
        // people reach for "Mark as used" to cover. Worth proving the walk sees it.
        const unit = microflow([
            activity("act-java", {
                $Type: "Microflows$JavaActionCallAction",
                $ID: "java-1",
                javaAction: "Sales.JA_RunLater",
                parameterMappings: [
                    {
                        $Type: "Microflows$JavaActionParameterMapping",
                        $ID: "map-1",
                        parameter: "Target",
                        value: {
                            $Type: "Microflows$MicroflowParameterValue",
                            $ID: "val-1",
                            microflow: "Billing.SUB_Invoice"
                        }
                    }
                ]
            })
        ]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]?.to).toBe("Billing.SUB_Invoice");
    });

    it("finds a suffixed reference property", () => {
        // `concurrencyErrorMicroflow` is one of eight properties that end in "Microflow" rather
        // than being named it. Hand-coded extractors miss these; the suffix rule does not.
        const unit = microflow([], { concurrencyErrorMicroflow: "Sales.SUB_OnError" });

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            to: "Sales.SUB_OnError",
            // Sits on the unit itself, so there is nothing drawable to focus.
            viaElementId: null,
            path: "concurrencyErrorMicroflow"
        });
    });

    it("finds a page button's microflow through microflowSettings", () => {
        const page = {
            $Type: "Pages$Page",
            $ID: "page-1",
            markAsUsed: false,
            widgets: [
                {
                    $Type: "Pages$ActionButton",
                    $ID: "button-1",
                    action: {
                        $Type: "Pages$MicroflowClientAction",
                        $ID: "clientaction-1",
                        microflowSettings: {
                            $Type: "Pages$MicroflowSettings",
                            $ID: "settings-1",
                            microflow: "Sales.ACT_Entry",
                            parameterMappings: []
                        }
                    }
                }
            ]
        };

        const edges = collectReferences(page, "Sales.Order_Edit", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]?.to).toBe("Sales.ACT_Entry");
        expect(edges[0]?.path).toBe("widgets[0].action.microflowSettings.microflow");
    });

    it("finds a scheduled event's microflow", () => {
        const event = {
            $Type: "ScheduledEvents$ScheduledEvent",
            $ID: "sched-1",
            enabled: true,
            microflow: "Sales.ACT_Entry"
        };

        const edges = collectReferences(event, "Sales.SE_Nightly", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ to: "Sales.ACT_Entry", viaElementId: null });
    });

    it("finds a rule reference", () => {
        const unit = microflow([
            {
                $Type: "Microflows$ExclusiveSplit",
                $ID: "split-1",
                relativeMiddlePoint: { x: 0, y: 0 },
                splitCondition: {
                    $Type: "Microflows$RuleSplitCondition",
                    $ID: "cond-1",
                    ruleCall: {
                        $Type: "Microflows$RuleCall",
                        $ID: "rulecall-1",
                        rule: "Sales.SUB_C",
                        parameterMappings: []
                    }
                }
            }
        ]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]?.to).toBe("Sales.SUB_C");
    });

    it("finds a mapping value converter", () => {
        // Mappings$ValueMappingElement.converter holds a microflow qualified name under a property
        // name that gives no hint of it. Missed by the first version of the allowlist, and caught
        // by the completeness audit in src/cli/validate.ts running over a real app.
        const mapping = {
            $Type: "ExportMappings$ExportMapping",
            $ID: "map-1",
            rootMappingElements: [
                {
                    $Type: "Mappings$ObjectMappingElement",
                    $ID: "root-1",
                    children: [
                        {
                            $Type: "Mappings$ValueMappingElement",
                            $ID: "child-1",
                            attribute: "Sales.Order.Total",
                            converter: "Sales.SUB_C"
                        }
                    ]
                }
            ]
        };

        const edges = collectReferences(mapping, "Sales.EXM_Order", resolves);

        expect(edges).toHaveLength(1);
        expect(edges[0]?.to).toBe("Sales.SUB_C");
        expect(edges[0]?.path).toBe("rootMappingElements[0].children[0].converter");
    });

    it("ignores a boolean property whose name ends in Microflow", () => {
        // Pages$GridActionButton.maintainSelectionAfterMicroflow is a boolean. The name matches the
        // suffix rule, so only the type check keeps it out.
        const page = {
            $Type: "Pages$Page",
            $ID: "page-2",
            widgets: [
                {
                    $Type: "Pages$GridActionButton",
                    $ID: "grid-button-1",
                    maintainSelectionAfterMicroflow: true
                }
            ]
        };

        expect(collectReferences(page, "Sales.Order_List", resolves)).toEqual([]);
    });

    it("ignores a property that merely starts with 'microflow'", () => {
        // Microflows$MicroflowPrimitiveParameterUrlSegment.microflowParameter names a *parameter*.
        const unit = microflow([], {
            urlSegment: {
                $Type: "Microflows$MicroflowPrimitiveParameterUrlSegment",
                $ID: "seg-1",
                microflowParameter: "Sales.SUB_B"
            }
        });

        expect(collectReferences(unit, "Sales.SUB_A", resolves)).toEqual([]);
    });

    it("ignores a reference to something outside the index", () => {
        const unit = microflow([activity("act-1", microflowCallAction("System.ShowHomePage"))]);

        expect(collectReferences(unit, "Sales.SUB_A", resolves)).toEqual([]);
    });

    it("terminates on a cyclic object graph", () => {
        const inner: Record<string, unknown> = {
            $Type: "Microflows$MicroflowCall",
            $ID: "call-1",
            microflow: "Sales.SUB_B"
        };
        // The model API returns cyclic element graphs in places; without the visited set this walk
        // would recurse until the stack blows.
        inner["parent"] = inner;

        const edges = collectReferences(
            microflow([activity("act-1", { $Type: "Microflows$MicroflowCallAction", microflowCall: inner })]),
            "Sales.SUB_A",
            resolves
        );

        expect(edges).toHaveLength(1);
    });

    it("records every call site separately when one microflow is called twice", () => {
        const unit = microflow([
            activity("act-1", microflowCallAction("Sales.SUB_B")),
            activity("act-2", microflowCallAction("Sales.SUB_B"))
        ]);

        const edges = collectReferences(unit, "Sales.SUB_A", resolves);

        expect(edges).toHaveLength(2);
        expect(edges.map(edge => edge.viaElementId).sort()).toEqual(["act-1", "act-2"]);
    });
});
