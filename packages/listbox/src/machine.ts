import { useCallback, useEffect, useRef, useState } from "react";
import { Descendant } from "@reach/descendants";
import { DistributiveOmit, useConstant, getOwnerDocument } from "@reach/utils";
import { assign, createMachine, interpret, StateMachine } from "@xstate/fsm";
import {
  ListboxDescendantProps,
  ListboxEvent,
  ListboxState,
  ListboxStateData,
  ListboxValue,
  MachineEventWithRefs,
  MachineToReactRefMap,
} from "./types";

let __DEBUG__ = true;

////////////////////////////////////////////////////////////////////////////////
// States

export enum ListboxStates {
  // Resting/closed state.
  Idle = "IDLE",

  // The user is navigate the list with a pointer
  Navigating = "NAVIGATING",

  // The user is navigate the list with a keyboard
  NavigatingWithKeys = "NAVIGATING_WITH_KEYS",

  // The user is searching for an option with the keyboard
  Searching = "SEARCHING",

  // The user is interacting with arbitrary elements inside the popover
  Interacting = "INTERACTING",
}

////////////////////////////////////////////////////////////////////////////////
// Events

export enum ListboxEvents {
  ButtonMouseDown = "BUTTON_MOUSE_DOWN",
  ButtonMouseUp = "BUTTON_MOUSE_UP",
  Blur = "BLUR",
  ClearNavSelection = "CLEAR_NAV_SELECTION",
  ClearTypeahead = "CLEAR_TYPEAHEAD",
  GetDerivedData = "GET_DERIVED_DATA",
  KeyDownEscape = "KEY_DOWN_ESCAPE",
  KeyDownEnter = "KEY_DOWN_ENTER",
  KeyDownSpace = "KEY_DOWN_SPACE",
  KeyDownNavigate = "KEY_DOWN_NAVIGATE",
  KeyDownSearch = "KEY_DOWN_SEARCH",
  KeyDownTab = "KEY_DOWN_TAB",
  KeyDownShiftTab = "KEY_DOWN_SHIFT_TAB",
  Navigate = "NAVIGATE",
  OptionMouseEnter = "OPTION_MOUSE_ENTER",

  // Uncontrolled value changes come from specific events (click, key, etc.)
  // ValueChange > Value change may have come from somewhere else
  ValueChange = "VALUE_CHANGE",

  OptionStartClick = "OPTION_START_CLICK",
  OptionFinishClick = "OPTION_FINISH_CLICK",
  PopoverPointerDown = "POPOVER_POINTER_DOWN",
  PopoverPointerUp = "POPOVER_POINTER_UP",
  UpdateAfterTypeahead = "UPDATE_AFTER_TYPEAHEAD",
}

////////////////////////////////////////////////////////////////////////////////
// Actions and conditions

let clearNavigationValue = assign<ListboxStateData>({
  navigationValue: null,
});

let clearTypeaheadQuery = assign<ListboxStateData>({
  typeaheadQuery: null,
});

let assignValue = assign<ListboxStateData, any>({
  value: (_, event) => event.value,
});

let navigate = assign<ListboxStateData, any>({
  navigationValue: (data, event) => event.value,
});

let navigateFromCurrentValue = assign<ListboxStateData, any>({
  navigationValue: data => data.value,
});

function listboxLostFocus(data: ListboxStateData, event: ListboxEvent) {
  if (event.type === ListboxEvents.Blur) {
    let { button, list, popover } = event.refs;
    let { relatedTarget } = event;

    let ownerDocument = (button && getOwnerDocument(button)) || document;

    return !!(
      ownerDocument.activeElement !== list &&
      popover &&
      !popover.contains(
        (relatedTarget as Element) || ownerDocument.activeElement
      )
    );
  }
  return false;
}

function optionIsActive(data: ListboxStateData, event: any) {
  let ownerDocument =
    (event.refs.popover && getOwnerDocument(event.refs.popover)) || document;
  return !!data.options.find(
    ({ element }) => element === ownerDocument.activeElement
  );
}

function focusList(data: ListboxStateData, event: any) {
  event.refs.list && event.refs.list.focus();
}

function focusNavOption(data: ListboxStateData, event: any) {
  requestAnimationFrame(() => {
    let node = getNavigationNodeFromValue(data, data.navigationValue);
    node && node.focus();
  });
}

function focusButton(data: ListboxStateData, event: any) {
  event.refs.button && event.refs.button.focus();
}

function optionIsSelectable(data: ListboxStateData, event: any) {
  if (event && event.disabled) {
    console.log("BLOCKED");
    return false;
  }
  return data.navigationValue != null;
}

function selectOption(data: ListboxStateData, event: any) {
  event.callback && event.callback(event.value);
}

let setTypeahead = assign<ListboxStateData, any>({
  typeaheadQuery: (data, event) => {
    return (data.typeaheadQuery || "") + event.query;
  },
});

let clearTypeahead = assign<ListboxStateData, any>({
  typeaheadQuery: "",
});

let setValueFromTypeahead = assign<ListboxStateData, ListboxEvent>({
  value: (data, event) => {
    if (event.type === ListboxEvents.UpdateAfterTypeahead && event.query) {
      let match = findOptionFromTypeahead(data.options, event.query);
      if (match && !match.disabled) {
        event.callback && event.callback(match.value);
        return match.value;
      }
    }
    return data.value;
  },
});

let setNavSelectionFromTypeahead = assign<ListboxStateData, ListboxEvent>({
  navigationValue: (data, event) => {
    if (event.type === ListboxEvents.UpdateAfterTypeahead && event.query) {
      let match = findOptionFromTypeahead(data.options, event.query);
      if (match && !match.disabled) {
        return match.value;
      }
    }
    return data.navigationValue;
  },
});

let commonEvents = {
  [ListboxEvents.GetDerivedData]: {
    actions: assign<ListboxStateData, any>((ctx, event) => {
      return {
        ...ctx,
        ...event.data,
        refs: {
          ...ctx.refs,
          ...(event.data.refs || {}),
        },
      };
    }),
  },
  [ListboxEvents.ValueChange]: {
    actions: [assignValue, selectOption],
  },
};

let openEvents = {
  [ListboxEvents.ClearNavSelection]: {
    actions: [clearNavigationValue, focusList],
  },
  [ListboxEvents.OptionFinishClick]: {
    target: ListboxStates.Idle,
    actions: [assignValue, selectOption, focusButton, clearTypeaheadQuery],
    cond: optionIsSelectable,
  },
  [ListboxEvents.KeyDownEnter]: {
    target: ListboxStates.Idle,
    actions: [assignValue, selectOption, focusButton, clearTypeaheadQuery],
    cond: optionIsSelectable,
  },
  [ListboxEvents.KeyDownSpace]: {
    target: ListboxStates.Idle,
    actions: [assignValue, selectOption, focusButton, clearTypeaheadQuery],
    cond: optionIsSelectable,
  },
  [ListboxEvents.ButtonMouseDown]: {
    target: ListboxStates.Idle,
    actions: [focusButton],
  },
  [ListboxEvents.KeyDownEscape]: {
    target: ListboxStates.Idle,
    actions: [focusButton],
  },
};

////////////////////////////////////////////////////////////////////////////////

/**
 * Initializer for our state machine.
 *
 * @param initial
 * @param props
 */
export const createListboxMachine = ({
  value,
}: {
  value: ListboxValue | null;
}) =>
  createMachine<ListboxStateData, ListboxEvent, ListboxState>({
    id: "mixed-checkbox",
    initial: ListboxStates.Idle,
    context: {
      value,
      refs: {
        button: null,
        input: null,
        list: null,
        popover: null,
      },
      options: [],
      navigationValue: null,
      typeaheadQuery: null,
    },
    states: {
      [ListboxStates.Idle]: {
        on: {
          ...commonEvents,
          [ListboxEvents.ButtonMouseDown]: {
            target: ListboxStates.Navigating,
            actions: [navigateFromCurrentValue, focusButton],
          },
          [ListboxEvents.KeyDownSpace]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigateFromCurrentValue, focusNavOption],
          },
          [ListboxEvents.KeyDownSearch]: {
            target: ListboxStates.Idle,
            actions: setTypeahead,
          },
          [ListboxEvents.UpdateAfterTypeahead]: {
            target: ListboxStates.Idle,
            actions: [setValueFromTypeahead],
          },
          [ListboxEvents.ClearTypeahead]: {
            target: ListboxStates.Idle,
            actions: clearTypeahead,
          },
          [ListboxEvents.KeyDownNavigate]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
        },
      },
      [ListboxStates.Interacting]: {
        on: {
          ...commonEvents,
          ...openEvents,
          [ListboxEvents.Blur]: [
            {
              target: ListboxStates.Idle,
              cond: listboxLostFocus,
              actions: clearTypeaheadQuery,
            },
            {
              target: ListboxStates.Navigating,
              cond: optionIsActive,
            },
            {
              target: ListboxStates.Interacting,
              actions: clearTypeaheadQuery,
            },
          ],
          [ListboxEvents.Navigate]: {
            target: ListboxStates.Navigating,
            actions: [navigate, focusNavOption],
          },
          [ListboxEvents.KeyDownNavigate]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
        },
      },
      [ListboxStates.Navigating]: {
        on: {
          ...commonEvents,
          ...openEvents,
          [ListboxEvents.Blur]: [
            {
              target: ListboxStates.Idle,
              cond: listboxLostFocus,
              actions: clearTypeaheadQuery,
            },
            {
              target: ListboxStates.Navigating,
              cond: optionIsActive,
            },
            {
              target: ListboxStates.Interacting,
              actions: clearTypeaheadQuery,
            },
          ],
          [ListboxEvents.ButtonMouseUp]: {
            // TODO: Figure out why `navigateFromCurrentValue` isn't assigning
            //       the value
            actions: [focusList, navigateFromCurrentValue, focusNavOption],
          },
          [ListboxEvents.Navigate]: {
            target: ListboxStates.Navigating,
            actions: [navigate, focusNavOption],
          },
          [ListboxEvents.KeyDownNavigate]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
          [ListboxEvents.KeyDownSearch]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: setTypeahead,
          },
          [ListboxEvents.UpdateAfterTypeahead]: {
            actions: [setNavSelectionFromTypeahead, focusNavOption],
          },
          [ListboxEvents.ClearTypeahead]: {
            actions: clearTypeahead,
          },
        },
      },
      [ListboxStates.NavigatingWithKeys]: {
        on: {
          ...commonEvents,
          ...openEvents,
          [ListboxEvents.Blur]: [
            {
              target: ListboxStates.Idle,
              cond: listboxLostFocus,
              actions: clearTypeaheadQuery,
            },
            {
              target: ListboxStates.NavigatingWithKeys,
              cond: optionIsActive,
            },
            {
              target: ListboxStates.Interacting,
              actions: clearTypeaheadQuery,
            },
          ],
          [ListboxEvents.Navigate]: {
            target: ListboxStates.Navigating,
            actions: [navigate, focusNavOption],
          },
          [ListboxEvents.KeyDownNavigate]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
          [ListboxEvents.KeyDownSearch]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: setTypeahead,
          },
          [ListboxEvents.UpdateAfterTypeahead]: {
            actions: [setNavSelectionFromTypeahead, focusNavOption],
          },
          [ListboxEvents.ClearTypeahead]: {
            actions: clearTypeahead,
          },
        },
      },
      [ListboxStates.Searching]: {
        on: {
          ...commonEvents,
          ...openEvents,
          [ListboxEvents.Blur]: [
            {
              target: ListboxStates.Idle,
              cond: listboxLostFocus,
              actions: clearTypeaheadQuery,
            },
            {
              target: ListboxStates.Searching,
              cond: optionIsActive,
            },
            {
              target: ListboxStates.Interacting,
              actions: clearTypeaheadQuery,
            },
          ],
          [ListboxEvents.Navigate]: {
            target: ListboxStates.Navigating,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
          [ListboxEvents.KeyDownNavigate]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: [navigate, focusNavOption, clearTypeaheadQuery],
          },
          [ListboxEvents.KeyDownSearch]: {
            target: ListboxStates.NavigatingWithKeys,
            actions: setTypeahead,
          },
          [ListboxEvents.UpdateAfterTypeahead]: {
            actions: [setNavSelectionFromTypeahead, focusNavOption],
          },
          [ListboxEvents.ClearTypeahead]: {
            actions: clearTypeahead,
          },
        },
      },
    },
  });

export function unwrapRefs<
  TE extends MachineEventWithRefs = MachineEventWithRefs
>(refs: MachineToReactRefMap<TE>): TE["refs"] {
  return Object.entries(refs).reduce((value, [name, ref]) => {
    (value as any)[name] = ref.current;
    return value;
  }, {} as TE["refs"]);
}

export function useMachine<
  TC extends object,
  TE extends MachineEventWithRefs = MachineEventWithRefs
>(
  initialMachine: StateMachine.Machine<TC, TE, any>,
  refs: MachineToReactRefMap<TE>
): [
  StateMachine.State<TC, TE, any>,
  StateMachine.Service<TC, DistributiveOmit<TE, "refs">>["send"],
  StateMachine.Service<TC, TE>
] {
  /*
   * State machine should not change between renders, so let's store it in a
   * ref. This should also help if we need to use a creator function to inject
   * dynamic initial state values based on props.
   */
  let { current: machine } = useRef(initialMachine);
  let service = useConstant(() => interpret(machine).start());
  let [current, setCurrent] = useState(machine.initialState);

  // Add refs to every event so we can use them to perform actions.
  let send = useCallback(
    (rawEvent: TE["type"] | DistributiveOmit<TE, "refs">) => {
      let event = typeof rawEvent === "string" ? { type: rawEvent } : rawEvent;
      let refValues = unwrapRefs(refs);
      let eventToSend = { ...event, refs: refValues } as TE;

      if (__DEV__ && __DEBUG__) {
        console.group("Event Sent");
        console.log(
          "%c" + eventToSend.type,
          "font-weight: normal; font-size: 120%; font-style: italic;"
        );
        console.log(eventToSend);
        console.groupEnd();
      }
      service.send(eventToSend);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    service.subscribe(setCurrent);
    return () => {
      service.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [current, send, service];
}

////////////////////////////////////////////////////////////////////////////////

function findOptionFromTypeahead(
  options: Descendant<HTMLElement, ListboxDescendantProps>[],
  string = ""
) {
  if (!string) return null;
  const found = options.find(
    option =>
      !option.disabled &&
      option.label &&
      option.label.toLowerCase().startsWith(string.toLowerCase())
  );
  return found || null;
}

function getNavigationNodeFromValue(data: ListboxStateData, value: any) {
  return data.options.find(option => value === option.value)?.element;
}

////////////////////////////////////////////////////////////////////////////////
// Types
