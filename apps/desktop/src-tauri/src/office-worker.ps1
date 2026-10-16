# Fixed Host adapter. All input is JSON data; never evaluate user/model code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OfficeWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$app = $null; $owned = $false; $doc = $null; $blank = $null

function Office-Preflight($path, $kind) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($path)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('.rels')) {
                if ($entry.Length -gt 1048576) { throw 'OfficeCapacityExceeded' }
                $reader=[IO.StreamReader]::new($entry.Open());try {$xml=[xml]$reader.ReadToEnd()} finally {$reader.Dispose()}
                foreach ($relationship in $xml.DocumentElement.ChildNodes) {
                    if ($relationship.TargetMode -eq 'External' -and !$relationship.Type.EndsWith('/hyperlink')) { throw 'OfficeExternalContentNotSupported' }
                }
            }
            if ($kind -eq 'excel' -and $entry.FullName -match '^xl/(connections.xml|externalLinks/|macrosheets/)') { throw 'OfficeExternalContentNotSupported' }
            if ($kind -eq 'excel' -and $entry.FullName -match '^xl/worksheets/.*\.xml$') {
                if ($entry.Length -gt 8388608) { throw 'OfficeCapacityExceeded' }
                $reader=[IO.StreamReader]::new($entry.Open());try {$xml=[xml]$reader.ReadToEnd()} finally {$reader.Dispose()}
                foreach ($formula in $xml.GetElementsByTagName('f')) {
                    if ($formula.InnerText -match '(?i)(WEBSERVICE|RTD|STOCKHISTORY|IMAGE|CALL|REGISTER|EXEC)\s*\(|\||\[[^\]]+\].*!') { throw 'OfficeExternalFormulaNotSupported' }
                }
            }
        }
    } finally {$zip.Dispose()}
}

function Word-Range($range, $id, $cell = $false) {
    $r = $range.Duplicate
    $r.End--
    $font = $r.Font
    $safe = $r.Fields.Count -eq 0 -and $r.Hyperlinks.Count -eq 0 -and $r.Revisions.Count -eq 0 -and $r.InlineShapes.Count -eq 0
    foreach ($property in @('Name','Size','Bold','Italic','Underline','Color')) {
        if ([string]$font.$property -eq '-9999999' -or [string]$font.$property -eq '') { $safe=$false }
    }
    $text=[string]$range.Text
    if ($cell) { $text=$text.TrimEnd([char[]]@([char]13,[char]7)) } else { $text=$text.Substring(0,[Math]::Max(0,$text.Length-1)) }
    if ($cell -and $text.Contains("`r")) { $safe=$false }
    return @{target=$id;text=$text;style=[string]$range.Style.NameLocal;safe=$safe;
        font=@{name=[string]$font.Name;size=$font.Size;bold=$font.Bold;italic=$font.Italic;underline=$font.Underline;color=$font.Color}}
}
function Word-Snapshot($d) {
    if ($d.Paragraphs.Count -gt 2000 -or $d.Tables.Count -gt 40 -or $d.Content.Text.Length -gt 200000) { throw 'OfficeCapacityExceeded' }
    $entries = [Collections.Generic.List[object]]::new()
    for ($i=1; $i -le $d.Paragraphs.Count; $i++) {
        $r=$d.Paragraphs.Item($i).Range
        if (!$r.Information(12)) { $entries.Add((Word-Range $r "p$i")) }
    }
    $tables=[Collections.Generic.List[object]]::new()
    for ($t=1; $t -le $d.Tables.Count; $t++) {
        $table=$d.Tables.Item($t)
        # Merged/nonrectangular tables cannot provide stable cell coordinates.
        if (!$table.Uniform) {
            $tables.Add(@{id="t$t";editable=$false;text=[string]$table.Range.Text})
            continue
        }
        if ($table.Range.Cells.Count -gt 400) { throw 'OfficeCapacityExceeded' }
        $tables.Add(@{id="t$t";rows=$table.Rows.Count;columns=$table.Columns.Count})
        for ($r=1; $r -le $table.Rows.Count; $r++) { for ($c=1; $c -le $table.Columns.Count; $c++) {
            $entries.Add((Word-Range $table.Cell($r,$c).Range "t${t}r${r}c${c}" $true))
        } }
    }
    $pictures=@($d.InlineShapes | ForEach-Object { @{type=$_.Type;height=$_.Height;width=$_.Width;alternative_text=$_.AlternativeText} })
    $headers=@($d.Sections | ForEach-Object { @{headers=@($_.Headers | ForEach-Object {$_.Range.Text});footers=@($_.Footers | ForEach-Object {$_.Range.Text})} })
    return @{kind='word';entries=@($entries.ToArray());tables=@($tables.ToArray());pictures=$pictures;headers=$headers;
        protection=$d.ProtectionType;revisions=$d.Revisions.Count;fields=$d.Fields.Count;shapes=$d.Shapes.Count;track_revisions=$d.TrackRevisions}
}
function Excel-Cell($s, $r, $date1904) {
    $v=$r.Value2; $f=if ($r.HasFormula) {[string]$r.Formula} else {$null}
    $type=if ($f) {'formula'} elseif ($null -eq $v) {'empty'} elseif ($v -is [bool]) {'boolean'} elseif ($v -is [string]) {'text'} elseif ($r.Value() -is [datetime]) {'date'} else {'number'}
    $dateNote=$null
    if ($type -eq 'date') {
        if (!$date1904 -and [double]$v -ge 60 -and [double]$v -lt 61) { $dateNote='Excel1900FictitiousLeapDay';$v='1900-02-29 (Excel legacy calendar)' }
        else { $serial=[double]$v+$(if ($date1904) {1462} elseif ([double]$v -lt 60) {1} else {0});$v=[datetime]::FromOADate($serial).ToString('yyyy-MM-ddTHH:mm:ss') }
    }
    $entry=@{sheet=$s.Name;cell=$r.Address($false,$false);kind=$type;value=$v;formula=$f;number_format=[string]$r.NumberFormat;date_system=$(if ($date1904) {'1904'} else {'1900'})}
    if ($dateNote) { $entry.date_note=$dateNote }
    return $entry
}
function Excel-Snapshot($d) {
    if ($d.Worksheets.Count -gt 20) { throw 'OfficeCapacityExceeded' }
    $sheets=[Collections.Generic.List[object]]::new(); $entries=[Collections.Generic.List[object]]::new(); $count=0
    foreach ($s in $d.Worksheets) {
        $u=$s.UsedRange
        $count += [long]$u.CountLarge
        if ($count -gt 10000) { throw 'OfficeCapacityExceeded' }
        $sheets.Add(@{name=$s.Name;range=$u.Address($false,$false);protected=[bool]$s.ProtectContents})
        foreach ($c in $u.Cells) { $entries.Add((Excel-Cell $s $c $d.Date1904)) }
    }
    return @{kind='excel';entries=@($entries.ToArray());sheets=@($sheets.ToArray());date1904=[bool]$d.Date1904}
}
function Cell-Scope($sheet, $address, $scope) {
    if ($scope -eq '*') { return }
    $pieces=$scope.Split('!')
    if ($pieces.Count -ne 2 -or $pieces[0] -ne $sheet.Name) { throw 'RangeOutsideScope' }
    $allowed=$sheet.Range($pieces[1]); $target=$sheet.Range($address)
    $intersection=$sheet.Application.Intersect($allowed,$target)
    if (!$intersection -or $intersection.CountLarge -ne $target.CountLarge) { throw 'RangeOutsideScope' }
}
function Scalar-Formula($sheet, $formula, $scope) {
    if ($formula.Length -gt 300 -or !$formula.StartsWith('=')) { throw 'UnsupportedFormula' }
    $rest=[regex]::Replace($formula.Substring(1),'\b(SUM|AVERAGE|COUNT|MIN|MAX)\b|\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}(?::\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6})?','')
    if ($rest -notmatch '^[0-9\s.+*/(),\-]*$') { throw 'UnsupportedFormula' }
    if ($scope -ne '*' -and $scope.Split('!')[0] -ne $sheet.Name) { throw 'RangeOutsideScope' }
    # Validate entire ranges, including interior cells, not just their endpoints.
    foreach ($m in [regex]::Matches($formula,'\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}(?::\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6})?')) {
        Cell-Scope $sheet $m.Value $scope
        if ($sheet.Range($m.Value).CountLarge -gt 10000) { throw 'OfficeCapacityExceeded' }
    }
    return $formula
}
function Equal-Cell($actual, $expected) {
    if (!$expected) { return $actual.kind -eq 'empty' }
    foreach ($key in @('sheet','cell','kind','formula','number_format','date_system')) {
        if ([string]$actual[$key] -cne [string]$expected.$key) { return $false }
    }
    return [string]$actual.value -ceq [string]$expected.value
}
function Apply-Word($d, $changes, $scope) {
    if ($d.ProtectionType -ne -1 -or $d.TrackRevisions) { throw 'UnsupportedProtectedOrTrackedDocument' }
    $before=Word-Snapshot $d
    foreach ($change in $changes) {
        $id=[string]$change.target
        if ($scope -ne '*' -and $id -notin $scope.Split(',')) { throw 'RangeOutsideScope' }
        $entry=@($before.entries | Where-Object {$_.target -ceq $id})
        if ($entry.Count -ne 1 -or !$entry[0].safe -or $entry[0].text -cne [string]$change.old) { throw 'WordTargetChangedOrUnsupported' }
        if ($id -match '^p([1-9][0-9]*)$') { $r=$d.Paragraphs.Item([int]$Matches[1]).Range.Duplicate; $r.End-- }
        elseif ($id -match '^t([1-9][0-9]*)r([1-9][0-9]*)c([1-9][0-9]*)$') { $r=$d.Tables.Item([int]$Matches[1]).Cell([int]$Matches[2],[int]$Matches[3]).Range.Duplicate; $r.End-- }
        else { throw 'UnsupportedWordTarget' }
        $r.Text=[string]$change.text
    }
    return $before
}
function Apply-Excel($d, $changes, $scope) {
    $before=Excel-Snapshot $d
    foreach ($change in $changes) {
        $s=$d.Worksheets.Item([string]$change.sheet)
        Cell-Scope $s ([string]$change.cell) $scope
        $r=$s.Range([string]$change.cell)
        if ($s.ProtectContents -or $r.MergeCells -or $r.HasArray -or $r.CountLarge -ne 1) { throw 'UnsupportedExcelTarget' }
        $old=Excel-Cell $s $r $d.Date1904
        if (!(Equal-Cell $old $change.old)) { throw 'ExcelTargetChanged' }
        switch ($change.kind) {
            'empty' { [void]$r.ClearContents() }
            'text' { $r.NumberFormat='@'; $r.Value2=[string]$change.value }
            'number' { $r.Value2=[double]$change.value }
            'boolean' { $r.Value2=[bool]$change.value }
            'date' { $dt=[datetime]::Parse([string]$change.value,[Globalization.CultureInfo]::InvariantCulture); $minimum=if ($d.Date1904) {[datetime]'1904-01-01'} else {[datetime]'1900-01-01'};if ($dt -lt $minimum) {throw 'DateOutsideWorkbookCalendar'};$r.Value2=$dt.ToOADate()-$(if ($d.Date1904) {1462} elseif ($dt -lt [datetime]'1900-03-01') {1} else {0}); if (!$change.number_format) {$r.NumberFormat='yyyy-mm-dd hh:mm:ss'} }
            'formula' { $r.Formula=(Scalar-Formula $s ([string]$change.value) $scope) }
            default { throw 'UnsupportedCellType' }
        }
        if ($change.number_format) { $r.NumberFormat=[string]$change.number_format }
    }
    [void]$d.Application.Calculate()
    foreach ($change in $changes) {
        $r=$d.Worksheets.Item([string]$change.sheet).Range([string]$change.cell)
        if ($r.Text -match '^#(VALUE!|REF!|DIV/0!|N/A|NAME\?|NUM!|SPILL!|CALC!|NULL!)$') { throw 'ExcelFormulaError' }
    }
    return $before
}
function Create-Word($d, $changes) {
    foreach ($change in $changes) {
        $end=$d.Content.End-1; $r=$d.Range($end,$end)
        if ($change.type -eq 'table') {
            $table=$d.Tables.Add($r,$change.rows.Count,$change.rows[0].Count)
            for ($row=0; $row -lt $change.rows.Count; $row++) { for ($col=0; $col -lt $change.rows[$row].Count; $col++) {
                $table.Cell($row+1,$col+1).Range.Text=[string]$change.rows[$row][$col]
            } }
            [void]$d.Range($d.Content.End-1,$d.Content.End-1).InsertParagraphAfter()
        } else {
            $r.Text=[string]$change.text+"`r"
            if ($change.type -eq 'heading') { $r.Style=-2 } else { $r.Style=-1 }
        }
    }
}
try {
    $kind = [string]$request.kind
    if ($kind -notin @('word','excel')) { throw 'UnsupportedOfficeKind' }
    $processName = if ($kind -eq 'word') {'WINWORD'} else {'EXCEL'}
    $existing = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $prog = if ($kind -eq 'word') {'Word.Application'} else {'Excel.Application'}
    $app = New-Object -ComObject $prog
    [uint32]$officePid = 0
    if ($kind -eq 'word') {
        # Word exposes HWND on a document Window, unlike Excel.Application.
        $doc = $app.Documents.Add()
        $hwnd = $doc.Windows.Item(1).Hwnd
    } else { $hwnd = $app.Hwnd }
    [void][OfficeWindow]::GetWindowThreadProcessId([IntPtr]$hwnd, [ref]$officePid)
    if (!$officePid -or $existing -contains [int]$officePid) { throw 'OfficeInstanceOwnershipUnproven' }
    $owned = $true
    if ($request.owner_file) { [IO.File]::WriteAllText([string]$request.owner_file,(@{pid=$officePid;creation_filetime=(Get-Process -Id $officePid).StartTime.ToFileTimeUtc()} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)) }
    $app.Visible = $false
    $app.AutomationSecurity = 3
    $app.DisplayAlerts = 0
    if ($doc) { $doc.Close($false); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc); $doc=$null }
    $result = @{status='Success';state='Ready';kind=$kind;application_pid=$officePid;existing_pids=$existing}
    if ($request.op -ne 'ready') {
        if ($request.op -eq 'create') {
            if ($kind -eq 'word') { $doc=$app.Documents.Add(); Create-Word $doc $request.changes }
            else {
                $doc=$app.Workbooks.Add()
                $names=@($request.changes | ForEach-Object {[string]$_.sheet} | Select-Object -Unique)
                if (!$names.Count -or $names.Count -gt 8) { throw 'UnsupportedSheetCount' }
                $doc.Worksheets.Item(1).Name=$names[0]
                for ($i=1; $i -lt $names.Count; $i++) { $s=$doc.Worksheets.Add(); $s.Name=$names[$i] }
                [void](Apply-Excel $doc $request.changes '*')
            }
        } else {
            Office-Preflight ([string]$request.path) $kind
            if ($kind -eq 'word') { $doc=$app.Documents.Open([string]$request.path,$false,$($request.op -ne 'patch'),$false) }
            else {
                $blank=$app.Workbooks.Add()
                $app.Calculation=-4135
                $doc=$app.Workbooks.Open([string]$request.path,0,$($request.op -ne 'patch'))
                $blank.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($blank);$blank=$null
            }
        }
        if ($request.op -in @('snapshot','patch','create')) {
            if ($request.op -eq 'patch') {
                if ($kind -eq 'word') { $result.before=Apply-Word $doc $request.changes ([string]$request.scope) }
                else { $result.before=Apply-Excel $doc $request.changes ([string]$request.scope) }
            }
            if ($request.op -in @('patch','create')) {
                if ($kind -eq 'word') { [void]$doc.SaveAs2([string]$request.output,12) }
                else { [void]$doc.SaveAs([string]$request.output,51) }
            }
            $result.snapshot=if ($kind -eq 'word') {Word-Snapshot $doc} else {Excel-Snapshot $doc}
        } elseif ($request.op -eq 'read_range' -and $kind -eq 'excel') {
            $s=$doc.Worksheets.Item([string]$request.sheet)
            Cell-Scope $s ([string]$request.range) ([string]$request.scope)
            $range=$s.Range([string]$request.range)
            if ($range.CountLarge -gt 200) { throw 'OfficeCapacityExceeded' }
            $values=[Collections.Generic.List[object]]::new()
            foreach ($c in $range.Cells) {$values.Add((Excel-Cell $s $c $doc.Date1904))}
            $result.entries=@($values.ToArray())
        } elseif ($request.op -eq 'calculate' -and $kind -eq 'excel') {
            $s=$doc.Worksheets.Item([string]$request.sheet)
            $formula=Scalar-Formula $s ([string]$request.formula) ([string]$request.scope)
            [void]$s.Calculate()
            $value=$s.Evaluate($formula)
            if ($value -is [array] -or $value -is [Runtime.InteropServices.ErrorWrapper] -or $value -is [int]) { throw 'NonScalarOrFormulaError' }
            $result.calculation=@{sheet=$s.Name;formula=$formula;value=$value}
        } else { throw 'UnsupportedOfficeOperation' }
    }
} catch {
    $result = @{status='Failed';state='Blocked';error=$_.Exception.Message;kind=$request.kind;owned_instance=$owned;application_pid=$officePid;existing_pids=$existing}
} finally {
    if ($doc) { try { $doc.Close($false) } catch { $result.status='Failed';$result.error='OwnedDocumentCloseFailed' } }
    if ($blank) { try { $blank.Close($false) } catch { $result.status='Failed';$result.error='OwnedBlankWorkbookCloseFailed' };[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($blank);$blank=$null }
    if ($owned -and $app) { try { $app.Quit() } catch { $result.status='Failed';$result.error='OwnedOfficeCloseFailed' } }
    if ($doc) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
    if ($app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
$result | ConvertTo-Json -Depth 24 -Compress
