let port = null;
let writer = null;
let reader = null;
let rows;
const IDLE = -1;
const CS_OK = -2;
const CS_BAD = -3;
const ACK = -4;
let state = IDLE;
let busy = false;
let readAddr = 0;
let checkSum = 0;

const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
document.body.style.backgroundColor = isDarkMode ? 'black' : 'white';
document.body.style.color = isDarkMode ? 'white' : 'black';
document.body.style.fontFamily = 'sans-serif';

const grid = document.getElementById("grid");
const scroller = document.getElementById("scroller");
const connectButton = document.getElementById("connectButton");
const readButton = document.getElementById("readButton");
const writeButton = document.getElementById("writeButton");
const saveButton = document.getElementById("saveButton");
const loadButton = document.getElementById("loadButton");
const statusDiv = document.getElementById("status");
const csvFile = document.getElementById("csvFile");
const block = new Uint8Array(224);
const eePacket = new Uint8Array(2);
const byteCommand = new Uint8Array(1);

function log(message)
{
    statusDiv.textContent=message;
}

function resizeScroller()
{
    scroller.style.height=Math.round(window.innerHeight-200) + "px";
}

function clamp(val, min, max)
{
    return val < min ? min : val > max ? max : val;
}

async function selectSerialPort()
{
	try 
	{ 
		port = await navigator.serial.requestPort();
	}
	catch 
	{ 
		port = null;
	}
}

function disposeSerial()
{
	try { if(writer != null) writer.releaseLock(); } catch { }
	try { if(reader != null) reader.releaseLock(); } catch { }
	try { if(port != null) port.close(); } catch { }	
}

function closeSerial() 
{
	disposeSerial();
	port = null;
	reader = null;
	writer = null;
}

async function openSerial()
{
	if(port != null)
	{
		try
		{
			await port.open({ baudRate: 38400 });
			writer = port.writable.getWriter();
			reader = port.readable.getReader();
			return;
		}
		catch { }
		closeSerial();	
	}
}

function setActiveButtons()
{
    readButton.disabled = port == null || busy;
    writeButton.disabled = port == null || busy;
    connectButton.disabled = busy;
    saveButton.disabled = busy;
    loadButton.disabled = busy;
}

function addSelectOption(sel, nme)
{
    const opt = document.createElement("option");
    opt.value=nme;
    opt.textContent=nme;
    sel.options.add(opt);
}

function formatFreqCell(ele)
{
    ele.value = parseFloat(ele.value < 18 ? 0 : ele.value > 1300 ? 1300 : ele.value).toFixed(5);
}

function setNum32(index, num)
{    
    block[index++] = num&0xff;
    num >>= 8;
    block[index++] = num&0xff;
    num >>= 8;
    block[index++] = num&0xff;
    num >>= 8;
    block[index] = num&0xff;
}

function toNum32(index)
{
    return block[index] + (block[index+1]<<8) + (block[index+2]<<16) + (block[index+3]<<24);    
}

function toBKFreq(decfreq) {
    return Math.round(decfreq * 100000.0) & 0x7fffffff;
}

function toDecimalFreq(bkfreq) {
    return bkfreq / 100000.0;
}

function encode()
{
    block[0] = 0x6D;
    block[1] = 0xA4;
    for(r = 1; r<21; r++)
    {
        const addr = ((r-1)*10)+2;
        const row = rows[r];
        setNum32(addr, toBKFreq(+row.startFreq.value));
        setNum32(addr + 4, toBKFreq(+row.endFreq.value));
        block[addr + 8] = +row.maxPower.value;
        byt = row.txAllowed.checked ? 1 : 0;
        byt |= row.wrap.checked ? 2 : 0;
        byt |= row.modulation.selectedIndex << 2;
        byt |= row.bandwidth.selectedIndex << 5;
        block[addr+9] = byt;
    }
}

function decode()
{
    const magic = block[0] == 0x6D && block[1] == 0xA4;
    for(r = 1; r<21; r++)
    {
        const addr = ((r-1)*10)+2;
        const row = rows[r];
        const start = toDecimalFreq(toNum32(addr));
        const end = toDecimalFreq(toNum32(addr + 4));
        if(magic && start && end && end>start && start>=18 && start<=1300 && end>=18 && end<=1300)
        {
            row.startFreq.value = start;
            row.endFreq.value = end;
            row.style.opacity = +row.startFreq.value && +row.endFreq.value ? 1 : 0.6;
            row.maxPower.value = block[addr+8] ? block[addr+8] : "";
            const byt = block[addr+9];
            row.txAllowed.checked = byt & 1;
            row.wrap.checked = byt & 2;
            row.modulation.selectedIndex = (byt & 0x1c) >> 2;
            row.bandwidth.selectedIndex = (byt & 0xe0) >> 5;        
        }
        else
        {
            row.startFreq.value = 0;
            row.endFreq.value = 0;
            row.style.opacity = 0.6;
            row.txAllowed.checked = false;
            row.maxPower.value = "";
            row.wrap.checked = false;
            row.modulation.selectedIndex = 1;
            row.bandwidth.selectedIndex = 1;
        }
        formatFreqCell(row.startFreq);
        formatFreqCell(row.endFreq);
    }
}

function processByte(b)
{
    if(state == IDLE)
    {
        switch(b)
        {
            case 0x30:
                state = 0;
                checkSum = 0;
                break;
            case 0x31:
            case 0x45:
            case 0x46:
                state = ACK;
                break;
        }
    }
    else
    {
        if(state < 32)
        {
            block[readAddr + state++] = b;
            checkSum += b;
        }
        else
        if(state == 32)
        {
            state = (checkSum & 0xff) == b ? CS_OK : CS_BAD;
        }
    }
}

async function readLoop()
{
    state = IDLE;
    try
    {
        while(port != null && state >= IDLE)
        {
            const { value, done } = await reader.read();
            if(done || !value)
            {
                break;
            }
            for(b of value)
            {
                processByte(b);
            }
        }
    }
    catch { }
}

function parseCsv(csv)
{
    csv = csv.replace("\r", "\n").replace("\n\n", "\n");
    const lines = csv.split("\n");
    const csvRegex = /"([^"]*(?:""[^"]*)*)"|([^,]+)|(?<=,|^)(?=,|$)/g;
    lineNum = 0;
    const headers = [];
    const csvrows = [];
    for(const line of lines)
    {
        const matches = Array.from(line.matchAll(csvRegex));
        colNum = 0;
        const fields = [];
        for (const match of matches) 
        {
            field = match[1] || match[2] || '';
            if (field && field.startsWith('"') && field.endsWith('"'))
            {
                field = field.slice(1, -1).replace(/""/g, '"');
            }
            if(lineNum != 0)
            {                
                fields[headers[colNum]] = field.trim();   
            }
            else
            {
                headers[colNum] = field.trim().toLowerCase();
            }
            colNum++;
        }
        if(lineNum)
        {
            csvrows.push(fields);
        }
        lineNum++;
    }
    return csvrows;
}

function exportCsv()
{
    csv = "Band_Num,Start,End,TX,Modulation,Bandwidth,Wrap,Max_Power\r\n";
    for(w = 1; w<21; w++)
    {
        r = rows[w];
        csv += `${w},`;
        csv += `${r.startFreq.value},`;
        csv += `${r.endFreq.value},`;
        csv += `${r.txAllowed.checked?"True":"False"},`;
        csv += `${r.modulation.value},`;
        csv += `${r.bandwidth.value},`;
        csv += `${r.wrap.checked?"True":"False"},`;
        csv += `${r.maxPower.value?r.maxPower.value:"Ignore"}\r\n`;
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "h3bandplan.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function loadCsv(csv)
{
    const csvrows = parseCsv(csv);
    if(csvrows[0])
    {
        if(csvrows[0]["band_num"]) // nicFW csv
        {
            for(const csvrow of csvrows)
            {
                const num = +csvrow["band_num"];
                if(num>0 && num<21)
                {
                    const row = rows[num];
                    row.startFreq.value = csvrow["start"];
                    row.endFreq.value = csvrow["end"];
                    row.txAllowed.checked = csvrow["tx"].toLowerCase() == "true";
                    row.modulation.value = csvrow["modulation"];
                    row.bandwidth.value = csvrow["bandwidth"];
                    row.wrap.checked = csvrow["wrap"].toLowerCase() == "true";
                    row.maxPower.value = +csvrow["max_power"] ? csvrow["max_power"] : 0;
                }
            }
            encode();
            decode();
            log("nicFW Band Plan Loaded");
        }
        else
            log("Not a band plan CSV");
    }
    else
        log("Empty CSV");
}

for(i = 0; i < 21; i++)
{
    const row = document.createElement("tr");
    row.offset = 0;    
    for(j = 0; j < 8; j++)
    {        
        const cell = document.createElement(i==0?"th":"td");
        const col = j;
        if(i > 0)
        {
            row.style.opacity = 0.6;
            switch(j)
            {
                case 0:
                    cell.textContent = i+" ";
                    cell.classList.add("index-cell");    
                    row.planNum = i;                
                    break;
                case 1:
                case 2:                    
                    const fbox = document.createElement("input");
                    fbox.type = "number";
                    fbox.max = 1300;
                    fbox.maxLength = 10;
                    fbox.min = 0;
                    fbox.value = "0.00000";
                    fbox.addEventListener("blur", (event) => {
                        formatFreqCell(fbox);
                        const startval = +row.startFreq.value;
                        const endval = +row.endFreq.value;
                        const thisVal = +fbox.value;
                        if(thisVal)
                        {
                            row.style.opacity = 1;
                            if(endval<=startval)
                            {
                                row.endFreq.value=startval;
                                formatFreqCell(row.endFreq);
                            }
                            if(!startval)
                            {
                                row.startFreq.value=endval;
                                formatFreqCell(row.startFreq);
                            }
                        }
                        else
                        {
                            row.style.opacity = 0.6;
                            row.startFreq.value = "0.00000";
                            row.endFreq.value = "0.00000";
                        }

                    });
                    cell.appendChild(fbox);
                    fbox.classList.add("freq-input");
                    if(col==1)
                        row.startFreq = fbox;
                    else
                        row.endFreq = fbox;
                    break;
                case 3:
                    const cbox = document.createElement("input");
                    cbox.type = "checkbox";
                    cell.appendChild(cbox);
                    cbox.classList.add("cb-input");  
                    row.txAllowed = cbox;              
                    break;
                case 4:
                    const mdd = document.createElement("select");
                    addSelectOption(mdd, "Ignore");
                    addSelectOption(mdd, "FM");
                    addSelectOption(mdd, "AM");
                    addSelectOption(mdd, "USB");
                    addSelectOption(mdd, "Enforce FM");
                    addSelectOption(mdd, "Enforce AM");
                    addSelectOption(mdd, "Enforce USB");
                    addSelectOption(mdd, "Enforce None");
                    mdd.selectedIndex = 1;
                    cell.appendChild(mdd);
                    row.modulation = mdd;
                    break;
                case 5:
                    const bdd = document.createElement("select");
                    addSelectOption(bdd, "Ignore");
                    addSelectOption(bdd, "Wide");
                    addSelectOption(bdd, "Narrow");
                    addSelectOption(bdd, "Enforce Wide");
                    addSelectOption(bdd, "Enforce Narrow");
                    addSelectOption(bdd, "FM Tuner");
                    bdd.selectedIndex = 1;
                    cell.appendChild(bdd);
                    row.bandwidth = bdd;
                    break;  
                case 6:
                    const wbox = document.createElement("input");
                    wbox.type = "checkbox";
                    cell.appendChild(wbox);
                    wbox.classList.add("cb-input");  
                    row.wrap = wbox;
                    break;
                case 7:
                    const pbox = document.createElement("input");
                    pbox.type = "number";
                    pbox.min = 0;
                    pbox.max = 255;
                    pbox.value = "";
                    pbox.placeholder = "Ignore";  
                    pbox.addEventListener("change", () => {
                        if(pbox.value==0) {
                            pbox.value="";
                        }
                    });     
                    cell.appendChild(pbox);
                    pbox.classList.add("power-input");
                    row.maxPower = pbox;
                    break;
            }
        }
        else
        {
            switch(j)
            {
                case 0:
                    cell.textContent="#";
                    break;
                case 1:
                    cell.textContent="Start Freq";
                    break;
                case 2:
                    cell.textContent="End Freq";
                    break;
                case 3:
                    cell.textContent="TX Allowed";
                    break;
                case 4:
                    cell.textContent="Modulation";
                    break;
                case 5:
                    cell.textContent="Bandwidth";
                    break;
                case 6:
                    cell.textContent="Wrap";
                    break;
                case 7:
                    cell.textContent="Max Power";
                    break;
            }
        }
        row.appendChild(cell);   
    }
    grid.appendChild(row);
}
rows = Array.from(grid.getElementsByTagName("tr"));
rows[1].startFreq.value = "138.00000";
rows[1].endFreq.value = "174.00000";
rows[1].wrap.checked = true;
rows[1].maxPower.value = 255;
rows[1].txAllowed.checked = true;
rows[1].style.opacity = 1;
rows[2].startFreq.value = "400.00000";
rows[2].endFreq.value = "520.00000";
rows[2].wrap.checked = true;
rows[2].maxPower.value = 255;
rows[2].txAllowed.checked = true;
rows[2].style.opacity = 1;
rows[3].startFreq.value = "108.00000";
rows[3].endFreq.value = "138.00000";
rows[3].maxPower.value = 0;
rows[3].wrap.checked = true;
rows[3].modulation.selectedIndex = 2;
rows[3].bandwidth.selectedIndex = 2;
rows[3].style.opacity = 1;
rows[4].startFreq.value = "630.00000";
rows[4].endFreq.value = "756.00000";
rows[4].maxPower.value = 0;
rows[4].modulation.selectedIndex = 7;
rows[4].style.opacity = 1;
rows[5].startFreq.value = "88.00000";
rows[5].endFreq.value = "108.00000";
rows[5].maxPower.value = 0;
rows[5].bandwidth.selectedIndex = 5;
rows[5].style.opacity = 1;
rows[20].startFreq.value = "18.00000";
rows[20].endFreq.value = "1300.00000";
rows[20].style.opacity = 1;
encode();
decode();

connectButton.addEventListener("click", async () => 
{
    closeSerial();
    await selectSerialPort();
    await openSerial();
    setActiveButtons();
    if(port==null)
    {
        log("Cannot open serial port");
    }
    else
    {
        log("Serial port opened");
    }

});

readButton.addEventListener("click", async () => 
{
    busy=true;
    setActiveButtons();
    okay = true;
    try
    {
        byteCommand[0]=0x45;
        await writer.write(byteCommand);
        await readLoop();
        if(state == ACK)
        {
            for(i=0; i<7; i++)
            {
                log(`Read Data ${i+1} of 7`);
                eePacket[0]=0x30;
                eePacket[1]=i+208;
                readAddr = i * 32;                
                await writer.write(eePacket);
                await readLoop();
                if(state != CS_OK)
                {
                    log("Bad checksum");
                    okay = false;
                    break;
                }
            }
        }
        byteCommand[0]=0x46;
        await writer.write(byteCommand);
        await readLoop();         
    }
    catch (error)
    {
        log("Read error " + error);
        okay = false;
    }
    if(okay)
    {
        log("Read complete");
    }
    else
    {
        block[0] = 0;
    }
    decode();
    busy=false;
    setActiveButtons();
});
    
writeButton.addEventListener("click", async () => 
{
    busy=true;
    setActiveButtons();
    okay = true;
    try
    {
        byteCommand[0]=0x45;
        await writer.write(byteCommand);
        await readLoop();
        if(state == ACK)
        {
            encode();
            for(x=0; x<7; x++)
            {
                log(`Write Data ${x+1} of 7`);
                eePacket[0]=0x31;
                eePacket[1]=x+208;
                byteCommand[0]=0;
                const start = x * 32;
                const end = start + 32;
                for(y=start; y<end; y++)
                {
                    byteCommand[0] += block[y];
                }
                await writer.write(eePacket);
                await writer.write(block.slice(start, end));
                await writer.write(byteCommand);
                await readLoop();
                if(state != ACK)
                {
                    okay=false;
                    log("No ACK from radio");
                    break;                    
                }
            }
            byteCommand[0]=0x49;
            await writer.write(byteCommand);
        }
        else
        {
            byteCommand[0]=0x46;
            await writer.write(byteCommand);
            await readLoop();                
        }
    }
    catch (error)
    {
        okay=false;
        log("Write error "+error);
    }
    busy = false;
    if(okay)
    {
        log("Write Finished");
    }
    setActiveButtons(); 
});

saveButton.addEventListener("click", async () => {
    exportCsv();
});

loadButton.addEventListener("click", async () => {
    csvFile.click();
});

document.getElementById("csvFile").addEventListener("change", function(event) {
    const file = event.target.files[0];
    if (file) 
    {
        const reader = new FileReader();
        reader.onload = function(e) {
            loadCsv(e.target.result);
        };
        reader.readAsText(file);    
    }
});