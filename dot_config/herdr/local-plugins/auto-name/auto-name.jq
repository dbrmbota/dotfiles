# auto-name.jq — pure naming function.
#
# Inputs:  $snap  (.result.snapshot with workspaces/tabs/panes/layouts)
#          $procs ({<pane_id>: .result.process_info})
#          $state ({panes:{...}, tabs:{...}}, or {} when missing/invalid)
#          $home  ($HOME for ~ collapsing)
#          $reset (true forces automatic names, false respects manual labels)
# Output:  {ops:[{kind:"pane"|"tab", id, label}], state:{panes,tabs}}
#
# Pane auto name: agent -> display_agent // agent (except "pi", owned by the
# Pi extension); else fg process basename (shell -> "prog: dir", truncated 32).
# Tab label: "N: (base // focused source label)" with manual-base tracking.

def truncate32:
  if type == "string" then .[0:32] else . end;

def base($p):
  (($p // "") | split("/") | last);

def prog_name($proc):
  ((($proc.argv0 // $proc.name) // "") | split("/") | last | ltrimstr("-"));

def shells:
  ["zsh", "bash", "fish", "sh", "dash", "nu"];

def fg_proc($pane; $procs):
  (($procs[$pane.pane_id] // null) as $pi
   | if $pi == null then null
     else (($pi.foreground_processes // []) as $fps
           | (($pi.foreground_process_group_id) as $fg
              | ((($fps | map(select(.pid == $fg)) | first)
                  // ($fps | last))))) end);

def pane_auto_name($pane; $procs; $home):
  (if ($pane.agent != null and $pane.agent != "pi") then
     ($pane.display_agent // $pane.agent)
   else (fg_proc($pane; $procs)) as $proc
     | if $proc == null then null
       else (prog_name($proc)) as $prog
         | if $prog == "" then null
           elif (shells | index($prog) != null) then
             ((($proc.cwd // $pane.foreground_cwd // $pane.cwd) // null)) as $cwd
             | if $cwd == null or $cwd == "" then $prog
               elif $cwd == $home then "\($prog): ~"
               else "\($prog): \(base($cwd))" end
           else $prog end end end) as $n
  | if $n == null or $n == "" then null else ($n | truncate32) end;

def effective_label($pane; $auto):
  (($pane.label // "") as $cur
   | if $cur != "" then $cur
     elif $auto != null then $auto
     elif $pane.agent == "pi" then "pi"
     else null end);

def is_owned($pane; $cur; $procs; $recorded; $reset):
  if $cur == "" then true
  elif $recorded != null and $cur == $recorded then true
  elif $reset then true
  elif ($cur | test("^pi( - .*)?$")) then
    (fg_proc($pane; $procs)) as $fp
    | $fp != null and (shells | index(prog_name($fp)) != null)
  else false end;

def tab_source_id($t; $lay; $snap):
  if $lay != null
     and (($lay.focused_pane_id // null) != null)
     and $lay.focused_pane_id != ""
  then $lay.focused_pane_id
  elif $lay != null and ((($lay.panes // []) | length) > 0) then
    ((($lay.panes | first).pane_id) // null)
  else
    ((($snap.panes // [])
      | map(select(.tab_id == $t.tab_id)) | first | .pane_id) // null)
  end;

def tab_apply($tid; $cur; $base; $desired):
  if $desired == $cur then
    .tabs[$tid] = {written: $cur, base: $base}
  else
    .ops += [{kind: "tab", id: $tid, label: $desired}]
    | .tabs[$tid] = {written: $desired, base: $base}
  end;

def pane_apply($id; $cur; $auto; $owned):
  if ($owned | not) then
    .panes |= del(.[$id])
  elif $auto != null and $auto != $cur then
    .ops += [{kind: "pane", id: $id, label: $auto}]
    | .panes[$id] = $auto
  elif $auto != null then
    .panes[$id] = $cur
  else .
  end;

def tab_base($t; $cur; $tabs; $reset):
  if $reset then null
  elif (($tabs | has($t.tab_id)) and $cur == $tabs[$t.tab_id].written) then
    $tabs[$t.tab_id].base
  elif ($cur | test("^[0-9]+$")) then null
  else (($cur | sub("^([0-9]+: ?)+"; ""))) as $b
    | if $b == "" then null else $b end
  end;

(($state // {}) | if type == "object" then . else {} end) as $st0
| ((($st0.panes // {}) | if type == "object" then . else {} end)) as $stpanes
| ((($st0.tabs // {}) | if type == "object" then . else {} end)) as $sttabs
| (reduce (($snap.layouts // [])[]) as $l ({}; .[$l.tab_id] = $l)) as $layouts
| (reduce (($snap.tabs // []) | to_entries[]) as $e ({counts: {}, list: []};
    ($e.value.workspace_id) as $ws
    | ((.counts[$ws] // 0) + 1) as $n
    | .counts[$ws] = $n
    | .list += [($e.value + {__n: $n})])
  | .list) as $ordered
| (reduce (($snap.panes // [])[]) as $pane ({ops: [], panes: $stpanes, eff: {}};
    ($pane.pane_id) as $id
    | (($pane.label // "") as $cur
    | if $pane.agent == "pi" then
        .panes |= del(.[$id])
        | .eff[$id] = effective_label($pane; null)
      else
        (pane_auto_name($pane; $procs; $home)) as $auto
        | (effective_label($pane; $auto)) as $eff
        | .eff[$id] = $eff
        | (is_owned($pane; $cur; $procs; .panes[$id]; $reset)) as $owned
        | pane_apply($id; $cur; $auto; $owned)
      end))) as $panes
| (reduce $ordered[] as $t ({ops: $panes.ops, panes: $panes.panes,
                             eff: $panes.eff, tabs: $sttabs};
    ($t.tab_id) as $tid
    | (($t.label // "") as $cur
    | (tab_source_id($t; $layouts[$tid]; $snap)) as $spid
    | (.eff[$spid] // null) as $src
    | if $src == null or $src == "" then .
      else
        (tab_base($t; $cur; .tabs; $reset)) as $base
        | ((($t.__n | tostring) + ": " + ($base // $src))) as $desired
        | tab_apply($tid; $cur; $base; $desired)
      end))) as $tabs
| (reduce (($snap.panes // [])[]) as $p ({}; .[$p.pane_id] = true)) as $livepanes
| (reduce (($snap.tabs // [])[]) as $t ({}; .[$t.tab_id] = true)) as $livetabs
| {ops: $tabs.ops,
   state: {panes: ($tabs.panes | with_entries(select($livepanes[.key]))),
           tabs: ($tabs.tabs | with_entries(select($livetabs[.key])))}}
