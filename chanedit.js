let port = null;
let writer = null;
let reader = null;
let rows;
let targetRow = null;
const IDLE = -1;
const CS_OK = -2;
const CS_BAD = -3;
const ACK = -4;
let state = IDLE;
let busy = false;

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
const block = new Uint8Array(33);
const eePacket = new Uint8Array(2);
const byteCommand = new Uint8Array(1);

function log(message)
{
    statusDiv.textContent=message;
}

function formatFreqCell(ele)
{
    ele.value = parseFloat(ele.value < 18 ? 0 : ele.value > 1300 ? 1300 : ele.value).toFixed(5);
}

function formatToneCell(ele)
{
    const cts = parseFloat(ele.value);
    if(cts>0 && cts<=3000)
        ele.value=cts.toFixed(1);
}

function addSelectOption(sel, nme)
{
    const opt = document.createElement("option");
    opt.value=nme;
    opt.textContent=nme;
    sel.options.add(opt);
}

function resizeScroller()
{
    scroller.style.height=Math.round(window.innerHeight-200) + "px";
}

function clamp(val, min, max)
{
    return val < min ? min : val > max ? max : val;
}

function toGroupWord(letters)
{
    r = 0;
    for(i = letters.length-1; i>=0; i--)
    {
        const cc = letters.toUpperCase().charCodeAt(i) - 64;
        if(cc>0 && cc<16)
        {
            r<<=4;
            r&=0xffff;
            r|=cc;
        }
    }
    return r;
}

function toGroupString(groupw)
{
    r = "";
    groupw&=0xffff;
    while(groupw>0)
    {
        nib = groupw&0xf;
        if(nib>0)
        {
            r+=String.fromCharCode(nib + 64);
        }
        groupw>>=4;
    }
    return r;
}

function toToneString(tonew)
{
    if(tonew>0 && tonew<=3000)
    {
        return tonew/10.0;
    }
    if(tonew>0x8000)
    {
        const rev = tonew>0xc000;
        tone = tonew&=0x3fff;
        if(tone<512)
        {
            str = "D";
            for(w=0; w<3; w++)
            {
                dig = (tone&0x1c0)>>6;
                tone<<=3;
                str+=dig;
            }
            str += rev ? "I" : "N";
            return str;
        }
    }
    return "Off";
}

function toToneWord(tone)
{
    const tonew = Math.round(Math.abs(tone)*10.0);
    if(tonew>=0 && tonew<=3000)
        return tonew;
    const toneu = tone.toUpperCase();
    const len = toneu.length - 1;
    if(len>1)
    {        
        if(toneu[0]=='D' && (toneu[len]=='N' || toneu[len]=='I'))
        {
            oct = 0;
            mag = 1;
            const rev = toneu[len]=='I';
            for(q = len-1; q >= 1; q--)
            {                
                oct += Math.round(toneu[q]) * mag;
                mag *= 8;
            }
            if(oct>=1 && oct<=511)
            {
                oct+=0x8000;
                if(rev)
                {
                    oct+=0x4000;
                }
                return oct;
            }
        }
    }
    return 0;
}

const toneDiv = document.createElement("div");




function toneMenu(td, ele)
{

}

function setNum16(index, num)
{    
    block[index++] = num&0xff;
    num >>= 8;
    block[index] = num&0xff;
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


function toNum16(index)
{
    return block[index] + (block[index+1]<<8);    
}

function toNum32(index)
{
    return block[index] + (block[index+1]<<8) + (block[index+2]<<16) + (block[index+3]<<24);    
}

function toFreq(index)
{
    const f = clamp(toNum32(index)/100000.0, 0.0, 1300.0);
    return f < 18 ? 0 : f;
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

function loadCsv(csv)
{
    const csvrows = parseCsv(csv);
    if(csvrows[0])
    {
        if(csvrows[0]["channel_num"]) // nicFW csv
        {
            nicFwCsv(csvrows);
            log("nicFW CSV Imported");
        }
        else
        if(csvrows[0]["location"]) // chirp csv
        {
            chirpCsv(csvrows);
            log("CHIRP CSV Imported");
        }
        else
            log("Unrecognized CSV");
    }
    else
        log("Empty CSV");
}

function chirpCsv(csvrows)
{
    for(const csvrow of csvrows)
    {
        txAllowed = true;
        const num = +csvrow["location"];
        if(num>0 && num<199)
        {
            const row = rows[num];
            const rx = +csvrow["frequency"];
            row.rxFreq.value = rx;
            tx = +csvrow["offset"];
            switch(csvrow["duplex"].toLowerCase())
            {
                case "split":                    
                    break;
                case "+":
                    tx += rx;
                    break;
                case "-":
                    tx = rx - tx;
                    break;
                case "off":
                    txAllowed = false;
                default:
                    tx = rx;
                    break;                                    
            }
            row.txFreq.value = tx;
            rxcts = csvrow["ctonefreq"];
            txcts = csvrow["rtonefreq"];
            rxdcs = "D" + csvrow["rxdtcscode"];
            txdcs = "D" + csvrow["dtcscode"];
            switch(csvrow["dtcspolarity"].toLowerCase())
            {
                default: // nn
                    txdcs += "N";
                    rxdcs += "N";
                    break;
                case "rn":
                    txdcs += "I";
                    rxdcs += "N";
                    break;
                case "nr":
                    txdcs += "N";
                    rxdcs += "I";
                    break;
                case "rr":
                    txdcs += "I";
                    rxdcs += "I";
                    break;
            }
            switch(csvrow["tone"].toLowerCase())
            {
                default:
                    rxcts = 0;
                    txcts = 0;
                    rxdcs = 0;
                    txdcs = 0;                    
                    break;
                case "dtcs":
                    rxcts = 0;
                    txcts = 0;
                    rxdcs = 0;
                    break;
                case "tone":
                    rxdcs = 0;
                    txdcs = 0;
                    rxcts = 0;
                    break;
                case "tsql":
                    rxdcs = 0;
                    txdcs = 0;
                    txcts = rxcts;
                    break;     
                case "cross":
                    switch(csvrow["crossmode"].toLowerCase())
                    {
                        case "tone->tone":
                            rxdcs = 0;
                            txdcs = 0;
                            break;
                        case "dtcs->":
                            rxcts = 0;
                            txcts = 0;
                            rxdcs = 0;
                            break;
                        case "->dtcs":
                            rxcts = 0;
                            txcts = 0;
                            txdcs = 0;
                            break;
                        case "tone->dtcs":
                            txdcs = 0;
                            rxcts = 0;
                            break;
                        case "dtcs->tone":
                            rxdcs = 0;
                            txcts = 0;
                            break;
                        case "->tone":
                            txcts = 0;
                            rxdcs = 0;
                            txdcs = 0;
                            break;
                        case "dtcs->dtcs":
                            rxcts = 0;
                            txcts = 0;
                            break;
                        case "tone->":
                            rxcts = 0;
                            rxdcs = 0;
                            txdcs = 0;
                            break;
                        default:
                            rxcts = 0;
                            txcts = 0;
                            rxdcs = 0;
                            txdcs = 0;
                            break;                        
                    }
                    break;           
            }
            wide = false;
            mode = 0;
            switch(csvrow["mode"].toLowerCase())
            {
                default:
                case "auto":
                    wide = true;
                    break;
                case "nfm":
                    mode = 1;
                    break;
                case "fm":
                case "wfm":
                    mode = 1;
                    wide = true;
                    break;
                case "nam":
                case "am":
                    mode = 2;
                    break;
                case "usb":
                    mode = 3;
                    break;
            }
            groups = csvrow["comment"].toUpperCase();
            if(!groups || groups.length>4)
            {
                groups = "";
            }
            if(!csvrow["skip"] && groups.indexOf("A")==-1)
            {
                groups = "A" + groups;
            }
            row.groups.value = groups;
            row.rxTone.value = rxcts ? rxcts : (rxdcs ? rxdcs : 0);
            row.txTone.value = txcts ? txcts : (txdcs ? txdcs : 0);
            row.modulation.selectedIndex = mode;
            row.bandwidth.selectedIndex = wide ? 0 : 1;
            row.chName.value = csvrow["name"];
            pwr = +csvrow["power"].toUpperCase().replace("W", "");
            if(pwr)
            {
                pwr*=51;
                if(pwr>255)
                {
                    pwr=255;
                }
            }
            else
            {
                pwr = 255;
            }
            row.txPower.value = txAllowed ? pwr : 0;
            targetRow = row;
            encodeBlock();
            decodeBlock();              
        }
    }
}


function nicFwCsv(csvrows)
{
    for(const csvrow of csvrows)
    {
        const num = +csvrow["channel_num"];
        if(num>0 && num<199)
        {
            const row = rows[num];
            row.chName.value = csvrow["name"];
            row.rxFreq.value = csvrow["rx"];
            row.txFreq.value = csvrow["tx"];
            row.rxTone.value = csvrow["rx_tone"];
            row.txTone.value = csvrow["tx_tone"];
            row.txPower.value = csvrow["tx_power"];
            row.groups.value = csvrow["slot1"] + csvrow["slot2"] + csvrow["slot3"] + csvrow["slot4"];
            row.bandwidth.value = csvrow["bandwidth"];
            row.modulation.value = csvrow["modulation"];
            targetRow = row;
            encodeBlock();
            decodeBlock();            
        }
    }
}

function exportCsv()
{
    csv = "Channel_Num,Active,Name,RX,TX,RX_Tone,TX_Tone,TX_Power,Slot1,Slot2,Slot3,Slot4,Bandwidth,Modulation\r\n";
    for(w = 1; w<199; w++)
    {
        r = rows[w];
        csv += `${w},`;
        if(Math.abs(r.rxFreq.value) == 0)
        {
            csv += "False,,,,,,,,,,,,\r\n";
        }
        else
        {
            csv += "True,";
            csv += `${r.chName.value.replace(",", ".").replace("\"", "'")},`;
            csv += `${r.rxFreq.value},`;
            csv += `${r.txFreq.value},`;
            csv += `${r.rxTone.value},`;
            csv += `${r.txTone.value},`;
            csv += `${r.txPower.value},`;
            csv += `${r.groups.value.length>0?r.groups.value[0]:""},`;
            csv += `${r.groups.value.length>1?r.groups.value[1]:""},`;
            csv += `${r.groups.value.length>2?r.groups.value[2]:""},`;
            csv += `${r.groups.value.length>3?r.groups.value[3]:""},`;
            csv += `${r.bandwidth.value},`;
            csv += `${r.modulation.value}\r\n`;
        }
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "h3channels.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function decodeBlock()
{
    const rx = toFreq(0);
    targetRow.rxFreq.value = rx;
    formatFreqCell(targetRow.rxFreq);
    if(rx==0)
    {
        targetRow.txFreq.value = 0;
        formatFreqCell(targetRow.txFreq);        
        targetRow.style.opacity = 0.6;
        targetRow.chName.value = "";
        targetRow.rxTone.value = "Off";
        targetRow.txTone.value = "Off";
        targetRow.txPower.value = "0";
        targetRow.groups.value = "";
        targetRow.bandwidth.selectedIndex = 0;
        targetRow.modulation.selectedIndex = 0;
    }
    else
    {
        targetRow.style.opacity = 1;
        const tx = toFreq(4);
        targetRow.txFreq.value = tx;
        formatFreqCell(targetRow.txFreq);
        const rxst = toNum16(8);
        targetRow.rxTone.value = toToneString(rxst);
        formatToneCell(targetRow.rxTone);
        const txst = toNum16(10);
        targetRow.txTone.value = toToneString(txst);
        formatToneCell(targetRow.txTone);
        targetRow.txPower.value = block[12];
        const groupw = toNum16(13);
        targetRow.groups.value = toGroupString(groupw);
        const bw = block[15]&1;
        targetRow.bandwidth.selectedIndex = bw;
        const mod = (block[15]&7)>>1;
        targetRow.modulation.selectedIndex = mod;
        cnt=20;
        cname = "";
        while(cnt<32 && block[cnt]!=0)
        {
            cname += String.fromCharCode(block[cnt++]);
        }
        targetRow.chName.value = cname;
    }
}

function encodeBlock()
{
    for(f=0; f<33; f++)
        block[f] = 0;
    const rx = Math.round(targetRow.rxFreq.value * 100000.0) >>> 0;
    const tx = Math.round(targetRow.txFreq.value * 100000.0) >>> 0;
    const rxst = toToneWord(targetRow.rxTone.value) >>> 0;
    const txst = toToneWord(targetRow.txTone.value) >>> 0;
    const grpw = toGroupWord(targetRow.groups.value) >>> 0;
    const modbw = targetRow.bandwidth.selectedIndex + (targetRow.modulation.selectedIndex<<1);
    setNum32(0, rx);
    setNum32(4, tx);
    setNum16(8, rxst);
    setNum16(10, txst);
    block[12] = Math.abs(targetRow.txPower.value) >>> 0;
    setNum16(13, grpw);
    block[15] = modbw;
    f = 20;
    for(l of targetRow.chName.value)
    {
        block[f++] = l.charCodeAt(0);
    }
    for(f=0; f<32; f++)
        block[32] += block[f];
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

function processByte(b)
{
    if(state == IDLE)
    {
        switch(b)
        {
            case 0x30:
                state = 0;
                block[32] = 0;
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
            block[state++] = b;
            block[32] += b;
        }
        else
        if(state == 32)
        {
            state = block[32] == b ? CS_OK : CS_BAD;
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

function setActiveButtons()
{
    readButton.disabled = port == null || busy;
    writeButton.disabled = port == null || busy;
    connectButton.disabled = busy;
    saveButton.disabled = busy;
    loadButton.disabled = busy;
}


window.addEventListener("resize", (event) => {
    resizeScroller();
});
resizeScroller();

for(i = 0; i < 199; i++)
{
    const row = document.createElement("tr");
    row.offset = 0;    
    for(j = 0; j < 10; j++)
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
                    row.chNum = i;                
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
                        fbox.value = clamp(fbox.value, 0, 1300);
                        formatFreqCell(fbox);
                        const val = Math.abs(fbox.value);
                        row.style.opacity = val > 0 ? 1.0 : 0.6;
                        if(col==2)
                        {
                            if(val == 0.0)
                            {
                                row.offset = 0;
                                row.rxFreq.value = 0;
                                formatFreqCell(row.rxFreq);                                
                            }
                            else
                            {
                                row.offset = Math.abs(row.txFreq.value) - Math.abs(row.rxFreq.value);
                            }
                        }
                        else
                        {                            
                            if(val == 0.0)
                            {
                                row.offset = 0;
                                row.txFreq.value = 0;
                            }
                            else
                            {
                                row.txFreq.value = clamp(val + row.offset, 18, 1300);
                            }
                            formatFreqCell(row.txFreq);                                
                        }
                    });
                    cell.appendChild(fbox);
                    fbox.classList.add("freq-input");
                    if(col==1)
                        row.rxFreq = fbox;
                    else
                        row.txFreq = fbox;
                    break;
                case 3:
                    const nbox = document.createElement("input");
                    nbox.type = "text";
                    nbox.maxLength = 12;
                    cell.appendChild(nbox);
                    nbox.classList.add("name-input");  
                    row.chName = nbox;              
                    break;
                case 4:
                case 5:
                    const tbox = document.createElement("input");
                    tbox.type = "text";
                    tbox.maxLength = 5;
                    tbox.value = "Off";
                    tbox.addEventListener("blur", (event) => {
                        const tw = toToneWord(tbox.value);
                        tbox.value = toToneString(tw);
                        formatToneCell(tbox);
                    });
                    tbox.addEventListener("dblclick", (event) => {
                        toneMenu(cell, tbox);
                    });
                    cell.appendChild(tbox);
                    tbox.classList.add("tone-input");
                    if(col==4)
                        row.rxTone = tbox;
                    else
                        row.txTone = tbox;                              
                    break;
                case 6:
                    const pbox = document.createElement("input");
                    pbox.type = "number";
                    pbox.min = 0;
                    pbox.max = 255;
                    pbox.value = 0;             
                    cell.appendChild(pbox);
                    pbox.classList.add("power-input");
                    row.txPower = pbox;
                    break;
                case 7:
                    const gbox = document.createElement("input");
                    gbox.type = "text";
                    gbox.maxLength = 4;
                    gbox.addEventListener("blur", (event) => {         
                        gbox.value = toGroupString(toGroupWord(gbox.value));
                    });                        
                    cell.appendChild(gbox);
                    gbox.className = "groups-input";
                    row.groups = gbox;
                    break;
                case 8:
                    const bdd = document.createElement("select");
                    addSelectOption(bdd, "Wide");
                    addSelectOption(bdd, "Narrow");
                    bdd.selectedIndex = 0;
                    cell.appendChild(bdd);
                    row.bandwidth = bdd;
                    break;                    
                case 9:
                    const mdd = document.createElement("select");
                    addSelectOption(mdd, "Auto");
                    addSelectOption(mdd, "FM");
                    addSelectOption(mdd, "AM");
                    addSelectOption(mdd, "USB");
                    mdd.selectedIndex = 0;
                    cell.appendChild(mdd);
                    row.modulation = mdd;
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
                    cell.textContent="RX Freq";
                    break;
                case 2:
                    cell.textContent="TX Freq";
                    break;
                case 3:
                    cell.textContent="Name";
                    break;
                case 4:
                    cell.textContent="RX Tone";
                    break;
                case 5:
                    cell.textContent="TX Tone";
                    break;
                case 6:
                    cell.textContent="TX Power";
                    break;
                case 7:
                    cell.textContent="Groups";
                    break;
                case 8:
                    cell.textContent="Bandwidth";
                    break;
                case 9:
                    cell.textContent="Modulation";
                    break;
    
            }
        }
        row.appendChild(cell);   
    }
    grid.appendChild(row);
}
rows = Array.from(grid.getElementsByTagName("tr"));

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
    state = -1;
});

readButton.addEventListener("click", async () => 
{
    busy = true;
    setActiveButtons();
    try
    {
        byteCommand[0]=0x45;
        await writer.write(byteCommand);
        await readLoop();
        if(state == ACK)
        {
            for(i=1; i<199; i++)
            {
                log(`Read Channel ${i} of 198`);
                targetRow = rows[i];
                eePacket[0]=0x30;
                eePacket[1]=i+1;
                await writer.write(eePacket);
                await readLoop();
                if(state == CS_OK)
                {
                    decodeBlock();
                }
            }
        }
        byteCommand[0]=0x46;
        await writer.write(byteCommand);
        await readLoop(); 
    }
    catch { }
    busy = false;
    log("Read Finished");
    setActiveButtons();
});

writeButton.addEventListener("click", async () => 
{
    busy=true;
    setActiveButtons();
    try
    {
        byteCommand[0]=0x45;
        await writer.write(byteCommand);
        await readLoop();
        if(state == ACK)
        {
            for(x=1; x<199; x++)
            {
                log(`Write Channel ${x} of 198`);
                targetRow = rows[x];
                encodeBlock();
                eePacket[0]=0x31;
                eePacket[1]=x+1;
                await writer.write(eePacket);
                await writer.write(block);
                await readLoop();
                if(state != ACK)
                    break;
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
    catch { }
    busy = false;
    log("Write Finished");
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