import React from "react";
import { GroupIntentWorkbenchView } from "./GroupIntentWorkbenchView.jsx";
import { useGroupIntentWorkbench } from "./useGroupIntentWorkbench";

export default function GroupIntentWorkbench() {
  return <GroupIntentWorkbenchView {...useGroupIntentWorkbench()} />;
}
