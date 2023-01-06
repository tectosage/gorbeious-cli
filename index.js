const fs = require('fs');
const prompt = require('prompt-sync')({sigint: true});
const _ = require('lodash');
const {Mnemonic, hd, KeyRing, Coin, MTX, Script, Input} = require('bcash')
const SLP = require('bcash/lib/script/slp')
const BigNumber = require('bignumber.js')
const {U64} = require('n64')
const {ChronikClient} = require('chronik-client');
const chronik = new ChronikClient("https://node.gorbeious.cash");

var mnemonicStore
var keyringStore
var coinStore = []
var reservedCoinStore = []
var tokenCoinStore = {}
var reservedTokenCoinStore = {}
var tokenRecordStore = {}
var historyStore = []
var signals = []
var websocketStore 
var reloading


try{
    var data = fs.readFileSync('./seed', 'ascii');
    mnemonicStore = new Mnemonic(data)
}catch{}

while(!mnemonicStore){
    var phrase = prompt('What is your Gorbeious mnemonic? (12 words) ')
    try{
        mnemonicStore = new Mnemonic(phrase.trim())
        try {
            fs.writeFileSync('./seed', mnemonicStore.toString());
        } catch (err) {
            console.error(err);
        }
    }catch (error){
        console.log('Thats an invalid phrase, are you sure you typed it correctly?')
    }
}

const keyring = (mnemonic) => {
    var master = hd.fromMnemonic(mnemonic);
    var hdkey = master.derivePath("m/44'/145'/0'/0");
    //var hdkey = master.derivePath("m/44'/1899'/0'");

    var child  = hdkey.derive(0);
    var keyringArray = [];

    for(let i =0; i < 20; i++){
        const grandchild = child.derive(i);
        const keyring = KeyRing.fromPrivate(grandchild.privateKey);
        keyring.hash = keyring.getHash().toString('hex')
        keyringArray.push(keyring);
    }

    return keyringArray
}

const getUtxos = async (keyringArray) => {
    //console.log('Getting UTXOs')
    let results = [];
    for(let i=0; i<keyringArray.length;i++){
        results[i] = chronik.script("p2pkh", keyringArray[i].getHash("hex")).utxos();
    }
    results = await Promise.all(results);
    let utxos = [];
    let slpCoins = [];
    for(let i=0; i<results.length; i++){ 
        if(results[i][0]){
            utxos.push(results[i][0]);
        }
    }
    return utxos;
}

const makeTokenRecord = async (tokenId) => {
    let tokenInfo = await chronik.token(tokenId)
    let slpData = tokenInfo.slpTxData.genesisInfo
    
    let tokenRecord = SLP.TokenRecord({tokenId: tokenId, ticker: slpData.tokenTicker,
    name:slpData.tokenName, uri: slpData.tokenDocumentUrl, hash: slpData.tokenDocumentHash,
    decimals: slpData.decimals})

    tokenRecord.totalMinted = tokenInfo.tokenStats.totalMinted
    tokenRecord.totalBurned = tokenInfo.tokenStats.totalBurned


    return tokenRecord
}

const generateCoins = async (utxos) => {
    utxos = await utxos
    let outputs = utxos;
    let coins = []
    let tokenCoins = {}
    let tokenRecords = _.cloneDeep(tokenRecordStore)
    let tokenFunds = {}
    for(let i=0; i<outputs.length;i++){
        let output = outputs[i];
        let utxos = output.utxos; 
        for(let a=0; a<utxos.length; a++){
            let utxo = utxos[a];
            let index = utxo.outpoint.outIdx
            let hash = Buffer.from(utxo.outpoint.txid, "hex").reverse()
            let options = {
                ...utxo, 
                version: 1, 
                value: parseInt(utxo.value), 
                height: utxo.blockHeight,
                coinbase: utxo.isCoinbase,
                script: Buffer.from(output.outputScript, "hex"),
                index: index,
                hash: hash,
            };
            let coin = new Coin(options);
            
            if(utxo.slpToken){ 
                let tokenId = Buffer.from(utxo.slpMeta.tokenId)
                let buffer = Buffer.allocUnsafe(4);
                buffer.writeUInt32BE(index, 0);  
                if(!tokenRecords[tokenId]){
                    tokenRecords[tokenId] = await makeTokenRecord(tokenId)
                }
                
                let record = SLP.SlpCoinRecord({hash: hash, vout: index,
                    tokenId: tokenId, tokenIndex: buffer, value: new BigNumber(utxo.slpToken.amount),//parseInt(utxo.slpToken.amount)
                    type: utxo.slpMeta.txType})

                coin.slp = record
               
                if(!tokenCoins[tokenId]){
                    tokenCoins[tokenId] = []
                }
                tokenCoins[tokenId].push(coin)

                let ticker = tokenRecords[tokenId].ticker;
                let value = new BigNumber(utxo.slpToken.amount).dividedBy(10 ** tokenRecords[tokenId].decimals)
                if(tokenFunds[tokenId]){
                    tokenFunds[tokenId].amount = value.plus(tokenFunds[tokenId].amount)
                }
                else{
                    tokenFunds[tokenId] = {}
                    tokenFunds[tokenId].amount = value
                }

            }
            else{
                coins.push(coin);
            }
        }
    }

    coinStore = coins
    tokenCoinStore = tokenCoins
    tokenRecordStore = tokenRecords
}

const getBalance = () =>{
    let sum = 0
    for(let i=0; i<coinStore.length;i++){
        sum += coinStore[i].value
    }
    return sum
}

const count = async (transaction) => {
    let keyringArray = keyringStore
    let slp = transaction.slpTxData ? true : false
    let count = 0
    let slpCount
    if(slp){slpCount = new BigNumber(0)}
    let reservedCoins = _.cloneDeep(reservedCoinStore)
    let coins = _.cloneDeep(coinStore)
    let validCoins = []
    
    let reservedTokenCoins
    let allTokenCoins
    let tokenCoins
    let validTokenCoins
    let tokenId
    if(slp){
        tokenId = transaction.slpTxData.slpMeta.tokenId
        allTokenCoins = _.cloneDeep(tokenCoinStore)
        if(allTokenCoins[tokenId]){
            tokenCoins = allTokenCoins[tokenId]
            
        }
        else{
            tokenCoins = []
        }

        reservedTokenCoins = _.cloneDeep(reservedTokenCoinStore)
        if(reservedTokenCoins[tokenId]){
            reservedTokenCoins = reservedTokenCoins[tokenId]
        }else{
                reservedTokenCoins = []
            }
        validTokenCoins = []

    }

    for(let i=0;i<transaction.inputs.length;i++){
        let input = transaction.inputs[i]
        if(keyringArray.map(v=>v.hash).includes(input.outputScript.slice(6, -4))){
            if(input.slpToken){
                count = count - parseInt(input.value)
                slpCount = slpCount.minus(new BigNumber(input.slpToken.amount))
            }else{
                count = count - parseInt(input.value)
            }
        }
    }
    
    for(let i=0;i<coins.length;i++){
        let coin = coins[i]
        let valid = true
        for(let i=0;i<transaction.inputs.length;i++){
            let input = transaction.inputs[i]
            if(input.prevOut.outIdx == coin.index && Buffer.from(input.prevOut.txid, 'hex').reverse().toString('hex') == coin.hash.toString('hex')){
                valid = false
                //count = count - coin.value
            }
        }
        if(valid){
            validCoins.push(coin)
        }
    }

    if(slp){
        for(let i=0;i<tokenCoins.length;i++){
            let coin = tokenCoins[i]
        
            let valid = true
            for(let i=0;i<transaction.inputs.length;i++){
                let input = transaction.inputs[i]
                if(input.prevOut.outIdx == coin.index && Buffer.from(input.prevOut.txid, 'hex').reverse().toString('hex') == coin.hash.toString('hex')){
                    valid = false
                }
            }
            if(valid){
                validTokenCoins.push(coin)
            }
        }
    }

    for(let i=0;i<transaction.outputs.length;i++){
        let output = transaction.outputs[i]
        if(keyringArray.map(v=>v.hash).includes(output.outputScript.slice(6, -4))){
            let hash = Buffer.from(transaction.txid, 'hex').reverse()
            let options = {
                hash: hash,
                index : i,
                script: Buffer.from(output.outputScript, 'hex'),
                value: parseInt(output.value),
                coinbase: transaction.isCoinbase
            }
            let coin = new Coin(options);
            
            if(output.slpToken){
                let valid = true
                if(reservedTokenCoins){
                    for(let i=0;i<reservedTokenCoins.length;i++){
                        let reservedCoin = reservedTokenCoins[i]
                        if(coin.index == reservedCoin.index && coin.hash.toString('hex') == reservedCoin.hash.toString('hex')){
                            valid = false
                            break
                        }
                    }
                }
                if(valid == true){
                    let tokenRecords = _.cloneDeep(tokenRecordStore)
                    if(!tokenRecords[tokenId]){
                        tokenRecords[tokenId] = await makeTokenRecord(tokenId)
                        tokenRecordStore = tokenRecords
                    }
                    let buffer = Buffer.allocUnsafe(4);
                    buffer.writeUInt32BE(i, 0);  
                    let record = SLP.SlpCoinRecord({hash: hash, vout: i,
                        tokenId: Buffer.from(transaction.slpTxData.slpMeta.tokenId),
                        tokenIndex: buffer,
                        value: new BigNumber(output.slpToken.amount),
                        type: transaction.slpTxData.slpMeta.txType})
                    coin.slp = record
                    validTokenCoins.push(coin)
                }
                slpCount = slpCount.plus(new BigNumber(output.slpToken.amount))

                count = count + parseInt(output.value)
                
            }else{
                let valid = true
                for(let i=0;i<reservedCoins.length;i++){
                    let reservedCoin = reservedCoins[i]
                    if(coin.index == reservedCoin.index && coin.hash.toString('hex') == reservedCoin.hash.toString('hex')){
                        valid = false
                        break
                    }
                }
                if(valid == true){
                    validCoins.push(coin)
                }

                count = count + parseInt(output.value)
            }
        }
    }

    if(slp){
        allTokenCoins[tokenId] = validTokenCoins
        tokenCoinStore = allTokenCoins
    }
    coinStore = validCoins
    transaction.value = count
    transaction.slpValue = slpCount

    return transaction
}

const simpleCount = (keyringArray, transaction) => {
    let slp = transaction.slpTxData ? true : false
    let count = 0
    let slpCount
    if(slp){slpCount= new BigNumber(0)}

    for(let i=0;i<transaction.inputs.length;i++){
        let input = transaction.inputs[i]
        if(keyringArray.map(v=>v.hash).includes(input.outputScript.slice(6, -4))){
            if(input.slpToken){
                count = count - parseInt(input.value)
                slpCount = slpCount.minus(new BigNumber(input.slpToken.amount))
            }else{
                count = count - parseInt(input.value)
            }
        }
    }

    for(let i=0;i<transaction.outputs.length;i++){
        let output = transaction.outputs[i]
        if(keyringArray.map(v=>v.hash).includes(output.outputScript.slice(6, -4))){
            
            if(output.slpToken){
                count = count + parseInt(output.value)
                slpCount = slpCount.plus(new BigNumber(output.slpToken.amount))

            }else{
                count = count + parseInt(output.value)
            }
        }
    }

    transaction.value = count
    transaction.slpValue = slpCount

    return transaction
}

const getHistory = async (keyringArray) => {
    //console.log('getting history')
    let tokenRecords = _.cloneDeep(tokenRecordStore)
    let array = []
    for(let i =0; i<keyringArray.length; i++){
        array.push(chronik.script('p2pkh', keyringArray[i].hash).history(0,200))
    }
    let results = await Promise.all(array)
    let transactions = []
    for(let i=0; i<results.length; i++){
        let set = results[i].txs
        for(let i=0; i<set.length; i++){
            let transaction = set[i]
            if(transaction.slpTxData){
                if(!tokenRecords[transaction.slpTxData.slpMeta.tokenId]){
                    tokenRecords[transaction.slpTxData.slpMeta.tokenId] = await makeTokenRecord(transaction.slpTxData.slpMeta.tokenId)
                }
            }
            let push = true
            for(let i=0;i<transactions.length; i++){
                if(transactions[i].txid == transaction.txid){
                    push = false
                    break
                }
            }
            if(push){
                transaction = simpleCount(keyringArray, transaction)
                transactions.push(transaction)
            }
        }
    }
    tokenRecordStore = tokenRecords

    let reservedUTXO = []
    let signals = []
    let payments = []

    transactions = transactions.map(tx=> swap(tx, transactions))
    transactions = await Promise.all(transactions)

    
    for(let i=0;i<transactions.length;i++){
        let transaction = transactions[i]

        if(transaction.swap){
            if(transaction.swap.type == 'signal'){
                if(transaction.swap.pointer && !transaction.swap.pointer.outputs[1].spentBy){
                    signals.push(transaction)
                    reservedUTXO.push(transaction.offeredUTXO)
                    reservedUTXO.push({index: 1, hash:Buffer.from(transaction.swap.pointer.txid, 'hex').reverse()})
                }else{
                    if(transaction.swap.status == 'Active'){
                        //console.log(transaction)
                    }
                }
            }else if(transaction.swap.status && transaction.swap.status == 'pending'){
                reservedUTXO = [...transaction.swap.inputs, ...reservedUTXO]
                //console.log('payment', transaction)
                payments.push(transaction)
            }
        }
    }



    let coins = _.cloneDeep(coinStore)
    let tokenCoins = _.cloneDeep(tokenCoinStore)
    let validCoins = []
    let validTokenCoins = {}
    let reservedCoins = []
    let reservedTokenCoins = {}

    for(let i=0;i<coins.length; i++){
        let valid = true
        for(let a=0;a<reservedUTXO.length;a++){
            if(coins[i].index == reservedUTXO[a].index && coins[i].hash.toString('hex') == reservedUTXO[a].hash.toString('hex')){
                valid = false
                break
            }
        }
        if(valid){
            validCoins.push(coins[i])
        }else{
            reservedCoins.push(coins[i])
        }
    }
    Object.keys(tokenCoins).forEach(function(tokenId, index){
        for(let i=0;i<tokenCoins[tokenId].length;i++){
            let valid = true
            for(let a=0;a<reservedUTXO.length;a++){
                if(tokenCoins[tokenId][i].index == reservedUTXO[a].index && tokenCoins[tokenId][i].hash.toString('hex') == reservedUTXO[a].hash.toString('hex')){
                    valid = false
                    break
                }
            }
            if(valid){
               if(validTokenCoins[tokenId]){
                validTokenCoins[tokenId].push(tokenCoins[tokenId][i])
               }else{
                validTokenCoins[tokenId] = [tokenCoins[tokenId][i]]
               } 
            }else{
                if(reservedTokenCoins[tokenId]){
                    reservedTokenCoins[tokenId].push(tokenCoins[tokenId][i])
                   }else{
                    reservedTokenCoins[tokenId] = [tokenCoins[tokenId][i]]
                   } 
            }
        }
    })

    coinStore = validCoins
    tokenCoinStore = validTokenCoins
    reservedCoinStore = reservedCoins
    reservedTokenCoinStore = reservedTokenCoins
    signals.sort((a,b) => a.timeFirstSeen - b.timeFirstSeen)
    signals = signals.reverse()
    getPayments(signals, transactions)
    transactions.sort((a,b) => a.timeFirstSeen - b.timeFirstSeen)
    return transactions.reverse()
}

const buildSendOpReturn = (tokenId, sendQuantityArray) => {
    const sendOpReturn = new Script()
            .pushSym('return')
            .pushData(Buffer.concat([
                Buffer.from('SLP', 'ascii'),
                Buffer.alloc(1)
            ]))
            .pushPush(Buffer.alloc(1, 1))
            .pushData(Buffer.from('SEND', 'ascii'))
            .pushData(Buffer.from(tokenId, 'hex'))
            for (let i = 0; i < sendQuantityArray.length; i++) {
                const sendQuantity = sendQuantityArray[i]
                sendOpReturn.pushData(U64.fromString(sendQuantity).toBE(Buffer))
            }
    return sendOpReturn.compile();
}

const sendToken = async (tokenId, amount, address, dust) => {
    let keyringArray = keyringStore
    let coins = coinStore
    let allTokenCoins = tokenCoinStore
    let tokenCoins = allTokenCoins[tokenId]
    let inputs = []
    
    try{
    const tx = new MTX();

    let finalTokenAmountSent = new BigNumber(0)
    let tokenAmountBeingSentToAddress = new BigNumber(amount).times(10 ** tokenRecordStore[tokenId].decimals)

    for(let i=0;i<tokenCoins.length;i++){
        if(finalTokenAmountSent.lt(tokenAmountBeingSentToAddress)){
            finalTokenAmountSent = finalTokenAmountSent.plus(new BigNumber(tokenCoins[i].slp.value))
            inputs.push(tokenCoins[i])
        }
    }

    let decodedTokenRecieverAddress = decode(address)

    let cleanTokenRecieverAddress = encode('ecash', 
    decodedTokenRecieverAddress.type, decodedTokenRecieverAddress.hash)

    const tokenAmountArray = [tokenAmountBeingSentToAddress.toString()]
    
    const tokenChangeAmount = finalTokenAmountSent.minus(tokenAmountBeingSentToAddress);
    if (tokenChangeAmount.gt(new BigNumber(0))){
        tokenAmountArray.push(tokenChangeAmount.toString());
    }
  
    
    const sendOpReturn = buildSendOpReturn(
        tokenId,
        tokenAmountArray
    );
    

    tx.addOutput(sendOpReturn, 0);
   
    if(!dust){
        tx.addOutput(cleanTokenRecieverAddress, 546) //currency.etokenSats
    }else{
        tx.addOutput(cleanTokenRecieverAddress, dust) //currency.etokenSats
    }
    
    if(tokenChangeAmount.gt(0)){
        tx.addOutput(keyringArray[10].getKeyAddress("string"), 546)
    }

    await tx.fund([
        ...inputs,
        ...coins
        ], {
            inputs: inputs.map(coin => Input.fromCoin(coin).prevout),
            changeAddress: keyringArray[10].getKeyAddress("string"),
            rate: 1000
    });
    tx.sign(keyringArray)
    //console.log(tx.toRaw().toString('hex'))

    let rawTx = Uint8Array.from(tx.toRaw());
    let resp = chronik.broadcastTx(rawTx);
    
    return [resp, tx]
    }catch (error){
        return [error]
    }
}

const coinFromTX = (tx, index, slp) => {
    let coin = new Coin({
        hash: tx.hash(),
        index : index,
        script: tx.outputs[index].script.raw,
        value: parseInt(tx.outputs[index].value)
    })

    if(slp){
        let buffer = Buffer.allocUnsafe(4);
        buffer.writeUInt32BE(slp.index, 0);  
        let record = SLP.SlpCoinRecord({hash: tx.hash(), vout: slp.index,
            tokenId: Buffer.from(slp.tokenId),
            tokenIndex: buffer,
            value: slp.value,
            type: slp.type})

        coin.slp = record
    }
    return coin
}

const countSpent = (tx, passedCoins) => {
    let keyringArray = keyringStore
    let arr = []
    let change = []
    let validCoins = []
    let coins = []
    if(!passedCoins){
        coins = _.cloneDeep(coinStore)
    }else{
        coins = passedCoins
    }

    for(let i=0;i<tx.inputs.length;i++){
        let a = {index: tx.inputs[i].prevout.index, hash: tx.inputs[i].prevout.hash}
        arr.push(a)
    }
    for(let i=0;i<coins.length; i++){
        let valid = true
        for(let a=0;a<arr.length;a++){
            if(coins[i].index == arr[a].index && coins[i].hash.toString('hex') == arr[a].hash.toString('hex')){
                valid = false
            }
        }
        if(valid){
            validCoins.push(coins[i])
        }
    }
    for(let i=0;i<tx.outputs.length;i++){
        let output = tx.outputs[i]
        if(output.value){
            if(keyringArray.map(v=>v.hash).includes(output.script.toRaw().toString('hex').slice(6, -4))){
                change.push(coinFromTX(tx, i))
            }
        }
    }
    if(!passedCoins){
        coinStore = validCoins
        return change
    }else{
        return([change, validCoins])
    }
}

const swap = async (transaction, passedHistory) => {
    let keyringArray = keyringStore
    let tokenRecords = _.cloneDeep(tokenRecordStore)
    let history
    if(!passedHistory){
        history = _.cloneDeep(historyStore)
    }else{
        history = passedHistory
    }

    let script = new Script(Buffer.from(transaction.outputs[0].outputScript, 'hex'))
    if(transaction.outputs[0].value == 0 && script.code[1] && script.code[1].data.toString('ascii') == "SWP\x00"){
        if(script.code[2].data && script.code[3].data && keyringArray.map(v=>v.hash).includes(transaction.inputs[0].outputScript.slice(6, -4))){
            if(script.code[2].data[0] == 1 && script.code[3].data[0] == 1){
                if(script.code.length == 6 && transaction.outputs.length > 2 && transaction.outputs[1].value == '546' && transaction.outputs[2].value == '546'){
                    transaction.swap = {description: 'Swap Signal 1/2', type: 'pointer'}
                    if(transaction.outputs[1].spentBy){
                        let spentBy = history.filter(h=>h.txid == transaction.outputs[1].spentBy.txid)[0]
                        if(spentBy && spentBy.value < 0 && !spentBy.slpValue){
                            transaction.swap.status = 'Cancelled'
                        }else{
                            transaction.swap.status = 'Completed'
                        }
                    }else{
                        transaction.swap.status = 'Active'
                    }
    
                }
                if(script.code.length == 11 && transaction.inputs[0].value == '546'){
                    let tokenId = script.code[4].data.toString('hex')
                    transaction.swap = {description: 'Swap Signal 2/2', type: 'signal',
                        tokenId: tokenId, offer: script.code[5].data.toString('ascii'),
                        rate: script.code[6].data.toString()/100}
                    if(!tokenRecords[tokenId]){
                        tokenRecords[tokenId] = await makeTokenRecord(tokenId)
                        tokenRecordStore = tokenRecords
                    }
                    let decimals = tokenRecords[tokenId].decimals
                    
                    let min = script.code[10].data
                    if(min[0] != 0){
                        if(min.toString() != '0'){
                            transaction.swap.minimum = Math.round(new BigNumber(min.toString()).div(100).div(transaction.swap.rate).times(10**decimals)) / (10 ** decimals)
                        }else{
                            transaction.swap.minimum = '0'
                        }
                    }
                    transaction.offeredUTXO = {index: script.code[9].data[0], hash: script.code[8].data}
                    if(!passedHistory){
                        await new Promise(resolve => setTimeout(resolve, 500));
                        history = _.cloneDeep(historyStore)
                    }
                    transaction.swap.pointer = history.filter(h=>h.txid == transaction.inputs[0].prevOut.txid)[0]
                    if(transaction.swap.pointer&& transaction.swap.pointer.outputs[1].spentBy){
                        let spentBy = history.filter(h=>h.txid == transaction.swap.pointer.outputs[1].spentBy.txid)[0]
                        if(spentBy && spentBy.value < 0 && !spentBy.slpValue){
                            transaction.swap.status = 'Cancelled'
                        }else{
                            transaction.swap.status = 'Completed!'
                        }
                    }else{
                        transaction.swap.status = 'Active'
                    }
                }
            
            }

        }
        if(script.code[2].data[0] == 2 && script.code[3].data[0] == 1){
            transaction.swap = {description: 'Payment TX', type: 'pointer payment'}
            transaction.swap.inputs = []
            let exchangeTX
            if(passedHistory){
                exchangeTX = await getTransactionFromPayment(transaction, history)
            }else{
                await new Promise(resolve => setTimeout(resolve, 500));
                history = _.cloneDeep(historyStore)
                exchangeTX = await getTransactionFromPayment(transaction)
            }
            if(exchangeTX && history.map(x=> x.inputs[0].prevOut.txid).includes(Buffer.from(exchangeTX.inputs[0].prevout.hash.toString('hex'), 'hex').reverse().toString('hex'))){
                transaction.swap.status = 'Completed!'
                //console.log('Found completed swap')
            }else if(exchangeTX){
                transaction.swap.baton = Buffer.from(exchangeTX.inputs[0].prevout.hash.toString('hex'), 'hex').reverse().toString('hex')
                transaction.swap.status = 'pending'
                transaction.swap.signalTXID = script.code[4].data.toString('hex')
                for(let i=0; i<exchangeTX.inputs.length; i++){
                    let input = exchangeTX.inputs[i]
                    let txid = Buffer.from(input.prevout.hash.toString('hex'), 'hex').reverse().toString('hex')
                    let tx = await getTransaction(txid)
                    transaction.swap.inputs.push({hash:input.prevout.hash, index: input.prevout.index, transaction: tx})

                    if(tx.outputs[input.prevout.index].spentBy){
                        transaction.swap.status = 'Cancelled/Completed'
                        break
                    }
                }
                if(transaction.swap.status == 'pending'){
                    if(transaction.swap.inputs[1].transaction.outputs[transaction.swap.inputs[1].index].slpToken){
                        transaction.swap.tokenId = transaction.swap.inputs[1].transaction.slpTxData.slpMeta.tokenId
                        transaction.swap.offer = 'SELL'
                    }else{
                        transaction.swap.tokenId = transaction.swap.inputs[2].transaction.slpTxData.slpMeta.tokenId
                        transaction.swap.offer ='BUY'
                    }
                    if(!tokenRecords[transaction.swap.tokenId]){
                        tokenRecords[transaction.swap.tokenId] = await makeTokenRecord(transaction.swap.tokenId)
                        tokenRecordStore = tokenRecords
                    }

                    if(transaction.swap.offer == 'SELL'){
                        transaction.swap.amount = parseInt(exchangeTX.outputs[0].script.code[5].data.toString('hex'), 16) / (10 ** tokenRecords[transaction.swap.tokenId].decimals)
                        transaction.swap.rate = Math.round(new BigNumber(transaction.swap.inputs[2].transaction.outputs[transaction.swap.inputs[2].index].value).minus(670).div(transaction.swap.amount)) /100    
                    }else{
                        transaction.swap.amount = transaction.swap.inputs[2].transaction.outputs[transaction.swap.inputs[2].index].slpToken.amount / (10 ** tokenRecords[transaction.swap.tokenId].decimals)
                        transaction.swap.rate = Math.round(new BigNumber(transaction.swap.inputs[1].transaction.outputs[transaction.swap.inputs[1].index].value).div(transaction.swap.amount)) /(100)
                    }
                }
            }
        }
    }else if (transaction.outputs[0].value == 0 && script.code.length < 4 && keyringArray.map(v=>v.hash).includes(transaction.inputs[0].outputScript.slice(6, -4))){
        if(script.length == 3){
            transaction.swap = {description: 'payment data', type: 'payment'}
        }else{
            transaction.swap = {description: 'payment payload', type: 'payload'}
        }
    }else if((transaction.value > 0 && transaction.slpValue < 0) || (transaction.value < 0 && transaction.slpValue > 0)){
        await new Promise(resolve => setTimeout(resolve, 500));
        transaction.isSwap = true
    }



    return transaction
}

const getTransaction = async (txid, passedHistory) => {
    let history
    if(passedHistory){
        history = passedHistory
    }else{
        history = historyStore
    }
    for(let i=0; i<history.length; i++){
        if(history[i].txid == txid){
            return(history[i])
        }
    }
    let tx = await chronik.tx(txid)
    return tx
}

const buildPayment = (signalTXID) => {
    const opReturn = new Script()
            .pushSym('return')
            .pushData(Buffer.from('SWP\x00', 'ascii'))
            .pushPush(Buffer.alloc(1, 2))
            .pushPush(Buffer.alloc(1, 1))
            .pushData(Buffer.from(signalTXID, 'hex'))

    return opReturn.compile();
}

const buildPointerSignalOpReturn = (tokenId, type) => {
    const signalOpReturn = new Script()
            .pushSym('return')
            .pushData(Buffer.from('SWP\x00', 'ascii'))
            .pushPush(Buffer.alloc(1, 1))
            .pushPush(Buffer.alloc(1, 1))
            .pushData(Buffer.from(tokenId, 'hex'))
            .pushData(Buffer.from(type, 'ascii'))
    return signalOpReturn.compile();
}

const buildSignal = (tokenId, type, rate, offeringCoin, minimumSats) => {
    const signalOpReturn = new Script()
            .pushSym('return')
            .pushData(Buffer.from('SWP\x00', 'ascii'))
            .pushPush(Buffer.alloc(1, 1))
            .pushPush(Buffer.alloc(1, 1))
            .pushData(Buffer.from(tokenId, 'hex'))
            .pushData(Buffer.from(type, 'ascii'))
            .pushData(Buffer.from(rate.toString()))
            .pushPush(Buffer.alloc(1, 0))
            .pushData(offeringCoin.hash)
            .pushPush(Buffer.alloc(1, offeringCoin.index))
            if(minimumSats == null){
                signalOpReturn.pushPush(Buffer.alloc(1, 0))
            }else{
                signalOpReturn.pushData(Buffer.from(minimumSats.toString()))
            }

    return signalOpReturn.compile();
}

const createOffer = async (tokenId, amount, rate, type, minimum) => {
    let keyringArray = keyringStore
    let coins = _.cloneDeep(coinStore)
    let allTokenCoins = _.cloneDeep(tokenCoinStore)
    let tokenCoins = allTokenCoins[tokenId]
    let tokenRecords = _.cloneDeep(tokenRecordStore)
    if(!tokenRecords[tokenId]){
        tokenRecords[tokenId] = await makeTokenRecord(tokenId)
        tokenRecordStore = tokenRecords
    }
    let decimals = tokenRecords[tokenId].decimals
    let offeredUTXO
    let change
    let count
    let reservedCoins = _.cloneDeep(reservedCoinStore)
    let minimumSats
    rate = Math.round(new BigNumber(rate).times(100))/100
    amount = Math.round(new BigNumber(amount).times(10**decimals)) / (10**decimals)

    if(minimum != null){
        minimum = Math.round(new BigNumber(minimum).times(10**decimals)) / (10**decimals)
        if(minimum == 0){
            minimumSats = 0
        }else{
            minimumSats = Math.round(new BigNumber(minimum).times(rate).times(100))
        }
    }

    if(type == 'SELL'){
        let allReservedTokenCoins = _.cloneDeep(reservedTokenCoinStore) 
        let reservedTokenCoins = []
        if(allReservedTokenCoins[tokenId]){
            reservedTokenCoins = allReservedTokenCoins[tokenId]
        }
        for(let i=0;i<tokenCoins.length;i++){
            if(tokenCoins[i].slp.value.eq(new BigNumber(amount).times(10 ** decimals))){
                offeredUTXO = tokenCoins[i]
                tokenCoins.splice(i,1)
                allTokenCoins[tokenId] = tokenCoins
                tokenCoinStore = allTokenCoins
                break
            }
        }
        if(!offeredUTXO){
            let result = await sendToken(tokenId, amount, keyringArray[11].getKeyAddress("string"))
            let resp = await result[0]
            let tx = result[1]
            count = countSpent(tx, coins)
            change = count[0]
            coins = count[1]
            offeredUTXO = coinFromTX(tx, 1, 
                {tokenId: tokenId, index: 1, value: new BigNumber(amount).times(10** decimals), type: 'SEND'})
            for(let i=0;i<change.length;i++){
                if(change[i].value > 546){
                    coins.push(change[i])
                }
            }
        }
        reservedTokenCoins.push(offeredUTXO)
        allReservedTokenCoins[tokenId] = reservedTokenCoins
        reservedTokenCoinStore = allReservedTokenCoins

    }else {
        reservedCoins = _.cloneDeep(reservedCoinStore)
        let totalSats = Math.round(new BigNumber(amount).times(rate).times(100))
        for(let i=0;i<coins.length;i++){
            if(coins[i].value == totalSats){
                offeredUTXO = coins.splice(i, 1)[0]
                break
            }
        }
        
        if(!offeredUTXO){
            let result = await sendXEC(keyringArray[12].getKeyAddress("string"), totalSats/100)
            let resp = await result[0]
            let tx = result[1]
            count = countSpent(tx,coins)
            change = count[0]
            coins = count[1]
            //console.log(resp, tx)
            offeredUTXO = coinFromTX(tx, 0)
            for(let i=0;i<change.length;i++){
                if(change[i].value != totalSats){
                    coins.push(change[i])
                }
            }
        }
        reservedCoins.push(offeredUTXO)
    }
    
    console.log('Creating pointer to Signal transaction')
    let pointerTX = new MTX()
    pointerTX.addOutput(buildPointerSignalOpReturn(tokenId, type), 0)
    pointerTX.addOutput(keyringArray[12].getKeyAddress("string"), 546); 
    pointerTX.addOutput(keyringArray[12].getKeyAddress("string"), 546); 
    await pointerTX.fund(coins, {
        changeAddress: keyringArray[12].getKeyAddress("string"),
        rate: 1000 // sats/thousand bytes
    })
    pointerTX.sign(keyringArray)

    count = countSpent(pointerTX, coins)
    change = count[0]
    coins = count[1]
    for(let i=0;i<change.length;i++){
        if(change[i].value != 546){
            coins.push(change[i])
        }
    }
    let batonCoin = coinFromTX(pointerTX, 1)
    reservedCoins.push(batonCoin)
    reservedCoinStore = reservedCoins
    let pointerCoin = coinFromTX(pointerTX, 2)
    let rawTx = Uint8Array.from(pointerTX.toRaw());
    let resp
    try{
        resp = await chronik.broadcastTx(rawTx);
    }catch{
        console.log("ERROR broadcasting offer pointer transaction", pointerTX.toRaw().toString('hex'))
    }
   // console.log('Creating Signal')
    let signalTX = new MTX()
    signalTX.addOutput(buildSignal(tokenId, type, rate*100, offeredUTXO, minimumSats), 0)
    await signalTX.fund([pointerCoin, ...coins], {
        inputs: [pointerCoin].map(coin => Input.fromCoin(coin).prevout),
        changeAddress: keyringArray[12].getKeyAddress("string"),
        rate: 1000 // sats/thousand bytes
    })
    signalTX.sign(keyringArray)
    count = countSpent(signalTX, coins)
    change = count[0]
    coins = count[1]
    rawTx = Uint8Array.from(signalTX.toRaw());
    resp = await chronik.broadcastTx(rawTx)
    //console.log('signal resp ', resp)
    
    let script = buildPayment(resp.txid)
    script = script.toRaw().toString('hex')
    let ws = websocketStore
    await ws.waitForOpen()
    ws.subscribe('other', script)
    console.log('added new signal to websocket')
    console.log(resp)
    return resp

}

const getTransactionFromPayment = async (transaction, transactions) => {
    //from payment transaction, if exchange transaction, find chunks and return transaction
    if(transaction.swap && !transactions){
        transaction = await chronik.tx(transaction.txid)
    }
    if(transaction.outputs.length > 1 && transaction.outputs[1].value == '546' && transaction.outputs[1].spentBy){
        try{
        let firstTX
        if(!transactions){
            firstTX = await chronik.tx(transaction.outputs[1].spentBy.txid)
        }else{
            firstTX=transactions.filter(tx=>tx.txid == transaction.outputs[1].spentBy.txid)[0]
        }
        let script = new Script(Buffer.from(firstTX.outputs[0].outputScript, 'hex'))
        if(script.code.length == 3){
            let numTransactions = script.code[1].data[0]
            let exchangeTX = script.code[2].data.toString('hex')
            let workingTX = firstTX
            for(let i=1;i<numTransactions;i++){
                if(workingTX.outputs.length > 1 && workingTX.outputs[1].spentBy){
                    if(!transactions){
                        workingTX = await chronik.tx(workingTX.outputs[1].spentBy.txid)
                    }else{
                        workingTX = transactions.filter(tx=>tx.txid == workingTX.outputs[1].spentBy.txid)[0]
                    }
                    let script = new Script(Buffer.from(workingTX.outputs[0].outputScript, 'hex'))
                    exchangeTX = exchangeTX + script.code[1].data.toString('hex')
                }
            }
            //console.log('exchange tx size ', Buffer.from(exchangeTX, 'hex').length)
            exchangeTX = MTX.fromRaw(Buffer.from(exchangeTX, 'hex'))
            return exchangeTX
        }}catch{
            //console.log('ERROR GETTING EXCHANGE TX FROM PAYMENT')
        }
    }
}

const getPayments = async (signals, history) => {
    let feeScript = '76a9140d7ca5e65c71d7d6038e0cc90637054373dce86588ac'
    let keyringArray= keyringStore
    let paymentSets = [] 
    for(let i=0;i<signals.length;i++){
        let signal = signals[i] 
        let script = buildPayment(signal.txid)
        script = script.toRaw().toString('hex')
        paymentSets.push(chronik.script('other', script).history(0, 100))
    }
    paymentSets = await Promise.all(paymentSets)
    for(let s=0; s<paymentSets.length;s++){
        let paymentSet = paymentSets[s].txs //slice to be removed
        let signal = signals[s]
        let tokenRecord
        try{
         tokenRecord = tokenRecordStore[signal.swap.tokenId]
        }catch(error){
            console.log(error, signal)
        }
        let decimals = tokenRecord.decimals
        let rate = signal.swap.rate
        let offer = signal.swap.offer
        let transactions = []
       // console.log('signal ', signal)
        for(let a=0; a<paymentSet.length; a++){
            transactions.push(getTransactionFromPayment(paymentSet[a]))
        }
        transactions = await Promise.all(transactions)

        for(let i=0; i<transactions.length;i++){
        try{
            console.log('NEW ITERATION')
            let transaction = transactions[i]
            let valid = false
            let inputs = []
            let outputs = transaction.outputs

            //console.log('INPUTS:')
            for(let i=0; i<transaction.inputs.length; i++){
                let hashhex = transaction.inputs[i].prevout.hash.toString('hex')
                let txid = Buffer.from(hashhex, 'hex').reverse().toString('hex')
                inputs.push(chronik.tx(txid))
            }

            //console.log('hash 1', transaction.hash())
            inputs = await Promise.all(inputs)
            for(let i=0;i<inputs.length;i++){
                let input = inputs[i]
                inputs[i] = {tx:input.txid, index:i, transaction:input, prevout: transaction.inputs[i].prevout.index}
            }

            let portion
            let remainder

            
            //console.log('hash 2', transaction.hash())
            if(signals[s].swap.offer == 'SELL'){
                valid = true

                if(outputs[0].script.code[6]){
                    portion = parseInt(outputs[0].script.code[5].data.toString('hex'), 16)
                    remainder =  parseInt(outputs[0].script.code[6].data.toString('hex'), 16)
                }
    
                if(portion && (!signals[s].swap.minimum || parseInt(signals[s].swap.minimum) > (portion / (10** decimals)))){
                    console.log('Payment marked invalid: Condition Below Minimum')
                    break
                }

                let offeringTX = await getTransaction(Buffer.from(signals[s].offeredUTXO.hash.toString('hex'), 'hex').reverse().toString('hex'))
                let slpTokens = (offeringTX.outputs[signals[s].offeredUTXO.index].slpToken.amount / (10** decimals))
              //  console.log(slpTokens)
                if(portion){
                    slpTokens = portion / (10** tokenRecord.decimals)
                }

                let amountOwedSats = Math.round(new BigNumber(slpTokens).times(rate).times(100))

                if(!portion){
                    amountOwedSats += 546
                }

                if(!(new BigNumber(slpTokens).times(rate).lt(546))){
                    signals[s].swap.fee = true
                }
               // console.log(signals[s].swap.fee)

                //verifies inclusion of baton and offered utxo
                if(inputs.length != 3 || inputs[0].tx != signals[s].inputs[0].prevOut.txid || Buffer.from(inputs[1].tx, 'hex').reverse().toString('hex') != signals[s].offeredUTXO.hash.toString('hex') || inputs[1].prevout != signals[s].offeredUTXO.index)
                {
                    console.log('Payment marked invalid: Condition 1')
                    valid = false
                    break
                }

                for(let i=2;i<inputs.length;i++){
                    let outputScript = inputs[i].transaction.outputs[inputs[i].prevout].outputScript
                    if(keyringArray.map(v=>v.hash).includes(outputScript.slice(6, -4))){
                        console.log('Payment marked invalid: Condition Stealing ')
                        valid = false
                        break
                    }
                }

                if((signals[s].swap.fee && portion && transaction.outputs.length < 5 )|| ((signals[s].swap.fee || portion) && transaction.outputs.length < 4) || transaction.outputs.length < 3){
                    console.log('Payment marked invalid: Condition Outputs Missing')
                    valid = false
                    break
                }

                if(portion && (outputs[0].script.toRaw().toString('hex') != buildSendOpReturn(signal.swap.tokenId, [portion.toString(), remainder.toString()]).toRaw().toString('hex'))){
                    //console.log(outputs[0].script.toRaw().toString('hex'))
                    //console.log(outputs[0].script.toRaw().toString('hex') == buildSendOpReturn(signal.swap.tokenId, [portion.toString(), remainder.toString()]).toRaw().toString('hex'))
                    console.log('Payment marked invalid: Bad OP_RETURN')
                    valid = false
                    break
                }

                if(!portion){
                    if(transaction.outputs[2].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript || transaction.outputs[2].value != amountOwedSats){
                        console.log('Payment marked invalid: Bring Me My Money, 1')
                        console.log(amountOwedSats)
                        console.log(transaction.outputs[2].value)
                        valid = false
                        break
                    }
                }else{
                    if(transaction.outputs[2].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript){
                        console.log('Payment marked invalid: Bad Token Change Script')
                        valid = false
                        break
                    }
                    if(transaction.outputs[3].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript || transaction.outputs[3].value != amountOwedSats){
                        console.log(amountOwedSats)
                        console.log('Payment marked invalid: Bring Me My Money, 2')
                        valid = false
                        break
                    }
                }

                if(!portion){
                    if(signals[s].swap.fee && (transaction.outputs[3].script.toRaw().toString('hex') != feeScript || transaction.outputs[3].value != Math.round(new BigNumber(slpTokens).times(rate)))){
                        console.log('Payment marked invalid: Only air is Fee 1 ')
                        valid = false
                        break
                    }
                }else{
                    if(signals[s].swap.fee && (transaction.outputs[4].script.toRaw().toString('hex') != feeScript || transaction.outputs[4].value != Math.round(new BigNumber(slpTokens).times(rate)))){
                        console.log('Payment marked invalid: Only air is Fee 2')
                        valid = false
                        break
                    }
                }


                for(let i=0;i<2;i++){
                    let input = transaction.inputs[i]
                    let hash = input.prevout.hash
                    let index = input.prevout.index
                    let script
                    let keyring
                    if(i==0){
                        script = signal.swap.pointer.outputs[1].outputScript
                    }else{
                        script = offeringTX.outputs[signals[s].offeredUTXO.index].outputScript
                    }
                    for(let i=0;i<keyringArray.length;i++){
                        if(script.includes(keyringArray[i].hash)){
                            keyring = keyringArray[i]
                        }
                    }
                    let coin = new Coin({
                        hash: hash,
                        index: index,
                        script: Buffer.from(script, 'hex'),
                        value: 546
                    })
                    //console.log(keyring)
                    //console.log(script)
                    transaction.scriptInput(i, coin, keyring)
                    transaction.signInput(i, coin, keyring)
                }

            }else{
                valid = true
                //verifies the inclusion of baton and offered utxo
                if(inputs.length < 3 || signals[s].inputs[0].prevOut.txid != inputs[0].tx || Buffer.from(inputs[1].tx, 'hex').reverse().toString('hex') != signals[s].offeredUTXO.hash.toString('hex') || transaction.inputs[1].prevout.index != signals[s].offeredUTXO.index){
                    console.log('Payment marked invalid: Condition One')
                    valid = false
                    break
                }
                for(let i=2;i<inputs.length;i++){
                    let outputScript = inputs[i].transaction.outputs[inputs[i].prevout].outputScript
                    if(keyringArray.map(v=>v.hash).includes(outputScript.slice(6, -4))){
                        console.log('Payment marked invalid: Condition Theft ')
                        valid = false
                        break
                    }
                }
                if(!inputs[2].transaction.outputs[inputs[2].prevout].slpToken){
                    console.log('Payment marked invalid: Offered coin not SLP')
                    valid = false
                    break
                }

                if(inputs[2].transaction.outputs[inputs[2].prevout].slpToken.amount / (10** tokenRecord.decimals) < signals[s].swap.minimum){
                    console.log('Payment marked invalid: Slp less than minimum ')
                    valid = false
                    break
                }

                let tokenAmount = Math.round(new BigNumber(inputs[1].transaction.outputs[signals[s].offeredUTXO.index].value).div(rate).div(100).times(10**decimals))/(10**decimals)
                if(inputs[2].transaction.outputs[inputs[2].prevout].slpToken.amount / (10** tokenRecord.decimals) < tokenAmount){
                    portion = inputs[2].transaction.outputs[inputs[2].prevout].slpToken.amount / (10** tokenRecord.decimals)
                    remainder = tokenAmount - portion
                    tokenAmount = portion
                }
                
                
                let tokenSats = tokenAmount * (10**tokenRecord.decimals)
                //tokenSats = Math.round(tokenSats)
                let sendOpReturn = buildSendOpReturn(signals[s].swap.tokenId, [tokenSats.toString()])

                if(!new BigNumber(tokenAmount).times(rate).times(100).div(100).lt(546)){
                    signals[s].swap.fee = true
                }
                //if(transaction.outputs.length < 3 || (signals[s].swap.fee && transaction.outputs.length < 4)){
                if(transaction.outputs.length < 3 || ((signals[s].swap.fee || portion) && transaction.outputs.length < 4) || (signals[s].swap.fee
                    && portion && transaction.outputs.length < 5)){
                    console.log('Payment marked invalid: Condition Lacking Outputs')
                    valid = false
                    break
                }

                //verifies opreturn
                if(sendOpReturn.toString('hex') != transaction.outputs[0].script.toString('hex')){
                    console.log('Payment marked invalid: Condition False OP_RETURN')
                    valid = false
                    break
                }

                //verifies amount of token and who they are sent to
                if(parseInt(inputs[2].transaction.outputs[inputs[2].prevout].slpToken.amount) != tokenSats || transaction.outputs[1].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript){
                    console.log('Payment marked invalid: Condition Bad SLP')
                    valid = false
                    break
                }

                //if(portion && (transaction.outputs[3].value != remainder * rate * 100 || transaction.outputs[3].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript)){
                if(portion && (transaction.outputs[3].value != Math.round(new BigNumber(remainder).times(rate).times(100))|| transaction.outputs[3].script.toRaw().toString('hex') != inputs[0].transaction.outputs[1].outputScript)){
                    console.log('Payment marked invalid: Lacking XEC change ')
                    valid = false
                    break
                }

                if(!portion){
                    if(signals[s].swap.fee && (transaction.outputs[3].script.toRaw().toString('hex') != feeScript || transaction.outputs[3].value != parseInt((tokenAmount * rate * .01 * 100).toFixed(0)))){
                        console.log("Payment marked invalid: Condition Bad Fee")
                        console.log(transaction.outputs[3].value, parseInt((tokenAmount * rate * .01 * 100).toFixed(0)))
                        valid = false
                        break
                    }
                }else{
                    if(signals[s].swap.fee && (transaction.outputs[4].script.toRaw().toString('hex') != feeScript || transaction.outputs[4].value != parseInt((tokenAmount * rate * .01 * 100).toFixed(0)))){
                        console.log("Payment marked invalid: Condition Bad Fee")
                        console.log(transaction.outputs[3].value, parseInt((tokenAmount * rate * .01 * 100).toFixed(0)))
                        valid = false
                        break
                    }
                }
                
                //console.log(transaction.hash())
                if(valid){
                    for(let i=0;i<2;i++){
                        let input = transaction.inputs[i]
                        let hash = input.prevout.hash
                        let index = input.prevout.index
                        let script
                        let keyring
                        let value
                        if(i==0){
                            script = inputs[0].transaction.outputs[1].outputScript
                            value = 546
    
                        }else{
                            script = inputs[1].transaction.outputs[inputs[1].prevout].outputScript
                            value = parseInt(inputs[1].transaction.outputs[signals[s].offeredUTXO.index].value)
                        }
                        for(let i=0;i<keyringArray.length;i++){
                            if(script.includes(keyringArray[i].hash)){
                                keyring = keyringArray[i]
                            }
                        }
                        let coin = new Coin({
                            hash: hash,
                            index: index,
                            script: Buffer.from(script, 'hex'),
                            value: value
                        })
                        //console.log(keyring)
                        //console.log(script)
                        transaction.scriptInput(i, coin, keyring)
                        transaction.signInput(i, coin, keyring)
                    }
                }
                remainder = remainder * (10**tokenRecord.decimals)
            }
            
            if(valid){
                console.log('VALID TX!!!')
                console.log('hash', transaction.hash())
                let rawTx = Uint8Array.from(transaction.toRaw());
                try{
    
                let resp = await chronik.broadcastTx(rawTx);
                console.log('swap transaction', resp)
                signals = signals.filter(s=>s.txid != signal.txid)
                if(remainder){
                    if(!reloading){
                    await new Promise(resolve => setTimeout(resolve, 500));
                       await reload(true)
                    }
                    
                    remainder = remainder / (10** tokenRecord.decimals)

                    try{
                    if(remainder > signal.swap.minimum){
                        await createOffer(signal.swap.tokenId, remainder, signal.swap.rate, signal.swap.offer, signal.swap.minimum)
                    }else{
                        await createOffer(signal.swap.tokenId, remainder, signal.swap.rate, signal.swap.offer)
                    }}catch (error){
                        console.log('Failed to relist offer', error)
                    }


                }

                break
                }catch(error){
                    console.log('couldnt broadcast', error)
                }
                // let resp = await chronik.broadcastTx(rawTx);
                //console.log(resp)
            }else{
                console.log('Found an exchange transaction but it was invalid')
            }
        }catch(e){
            console.log('error', e)
        }
        }
    }
}

const socket = async () => {
    let keyringArray = keyringStore
    let signalss = _.cloneDeep(signals)
    let arr = []
    console.log('opening websocket')
    const ws = chronik.ws({
      onMessage: msg => {
        if(msg.txid && !arr.includes(msg.txid )&& !historyStore.map(a=>a.txid).includes(msg.txid)){
          console.log("Got update: ", msg)
          arr.push(msg.txid)
          incoming(msg.txid)
        }
      },
      onReconnect: e => {
        // Fired before a reconnect attempt is made:
        //console.log("Reconnecting websocket, disconnection cause: ", e)
      },
    })
    const swapWS = chronik.ws({
      onMessage: async(msg) => {
        console.log('got a swap websocket message!')
        //console.log(msg)
        if(msg.txid && !arr.includes(msg.txid) && !historyStore.map(a=>a.txid).includes(msg.txid)){
            console.log('waiting')
          await new Promise(resolve => setTimeout(resolve, 1000));
          getPayments(_.cloneDeep(signals), _.cloneDeep(historyStore))
        }
      },
      onReconnect: e => {
        //console.log('Reconnecting Swap websocket')
      }
    })
    websocketStore = swapWS

    await ws.waitForOpen()
    console.log('opened websocket')
    for(let i=0; i<keyringArray.length; i++){
        ws.subscribe("p2pkh", keyringArray[i].hash)
    }

    await swapWS.waitForOpen()
    console.log('opened swap websocket')
    for(let i=0; i<signalss.length; i++){
      let script = buildPayment(signalss[i].txid)
      script = script.toRaw().toString('hex')
      swapWS.subscribe('other', script)
    }

}

const incoming = async (txid) => {
    console.log('incomingg transaction')
    let transaction = await chronik.tx(txid)
    transaction = await count(transaction)
    transaction = await swap(transaction)
    
    if(transaction.swap && transaction.swap.type == 'signal'){
    console.log('New Signal Created')
      signals = [transaction, ...signals]
      let ws = websocketStore
      ws.waitForOpen()
      let script = buildPayment(transaction.txid)
      script = script.toRaw().toString('hex')
      ws.subscribe('other', script)
    } 
    historyStore = [transaction, ...historyStore]
}

async function reload(notHistory){
    reloading = true
    try{
    var utxos = getUtxos(keyringStore)
    await generateCoins(utxos)

    if(!notHistory){
        historyStore = await getHistory(keyringStore)
    }
    console.log('reloaded')
    }catch(error){
        //console.log('couldnt reload')
    }
    reloading = false
}

async function reloadTimer(){
    await new Promise(resolve => setTimeout(resolve, 10000));
    if(!reloading){
        await reload()
    }
    reloadTimer()
}

async function live(){
    try{
    let time = Date.now()
    let sign = keyringStore[12].sign(Buffer.from(time.toString()))
    let pubkey = keyringStore[12].publicKey.toString('hex')
    
    
    await fetch('https://gorbeious.cash/live/', {method: "POST", headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
        time: time,
        pubkey: pubkey.toString('hex'),
        message: sign.toString('hex')
    })})
    
    }catch(error){
       // console.log(error)
    }
    

    await new Promise(resolve => setTimeout(resolve, 5000));
    live()

}

async function main(){
    keyringStore = keyring(mnemonicStore)

    await live()
    await reload()
    var balance = getBalance()
    console.log(`Found a balance of ${balance/100} XEC`)
    socket()
    reloadTimer()
}

main()