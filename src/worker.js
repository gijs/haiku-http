var http = require('http')
	, https = require('https')
	, url = require('url')
	, vm = require('vm')
	, cluster = require('cluster')

var shutdown
	, shutdownInProgress = false
	, activeRequests = 0
	, requestCount = 0
	, argv

process.on('message', function (msg) {
	process.send({ response: msg.challange });
})
.on('uncaughtException', function (err) {
	log('Entering shutdown mode after an uncaught exception: ' 
		+ (err.message || err) + '\n'
		+ (err.stack || ''));
	initiateShutdown();
});

function log(thing) {
	console.log(process.pid + ': ' + thing);
}

function shutdownNext() {
	if (shutdown) {
		clearTimeout(shutdown);
		shutdown = undefined;
	}

	process.nextTick(function() {
		log('Recycling self. Active requests: ' + activeRequests)
		process.exit();
	});	
}

function initiateShutdown() {
	if (!shutdownInProgress) {

		// stop accepting new requests

		httpServer.close();
		httpsServer.close();		

		shutdownInProgress = true;

		if (0 === activeRequests) {
			// there are no active requests - shut down now
			shutdownNext();
		}
		else {
			// delayed shutdown allows active requests to finish processing
			// shutdown timeout is the same as the handler processing timeout
			shutdown = setTimeout(shutdownNext, argv.t); 
		}
	}
}

function onRequestFinished(context) {
	if (!context.finished) {
		context.finished = true;
		activeRequests--;
		if (shutdownInProgress && 0 === activeRequests) {

			// we have finished processing the last active request while in shutdown mode
			// no reason to delay the shutdown any more - proceed to shutdown now

			shutdownNext();
		}
	}
}

function haikuError(context, status, error) {
	log(new Date() + ' Status: ' + status + ', Error: ' + error);
	try {
		context.req.resume();
		context.res.writeHead(status);
		if ('HEAD' !== context.req.method)
			context.res.end((typeof error === 'string' ? error : JSON.stringify(error)) + '\n');
		else
			context.res.end();
	}
	catch (e) {
		// empty
	}
	onRequestFinished(context);
}

// defines the subset of module functionality that will be exposed
// to the haiku-http handler via the "require" function

var moduleSandbox = {
	'http' : {
		request: wrapHttpRequest,
		get: wrapHttpRequest
	},
	'https' : {
		request: true,
		get: true		
	},
	'url' : true
}

// defines properties from http.ClientRequest (own and inherited) that will be
// exposed to the haiku-http handler

var clientRequestSandbox = {
	writable: true,
	write: true,
	end: true,
	abort: true,
	setTimeout: true,
	setNoDelay: true,
	setSocketKeepAlive: true,
	pipe: true,
	addListener: wrapResponseEvent,
	on: wrapResponseEvent,
	once: wrapResponseEvent,
	removeListener: true,
	removeAllListeners: true,
	setMaxListeners: true,
	listeners: true,
	emit: true	
}

// defines properties from http.ClientResponse (own and inherited) that will be
// exposed to the haiku-http handler

var clientResposeSandbox = {
	readable: true,
	statusCode: true,
	httpVersion: true,
	headers: true,
	trailers: true,
	setEncoding: true,
	pause: true,
	resume: true,
	pipe: true,
	addListener: true,
	on: true,
	once: true,
	removeListener: true,
	removeAllListeners: true,
	setMaxListeners: true,
	listeners: true,
	emit: true
}

// defines properties from http.ServerRequest (own and inherited) that will be
// exposed to the haiku-http handler

var serverRequestSandbox = { 
	readable: true,
	method: true,
	url: true,
	headers: true,
	trailers: true,
	httpVersion: true,
	setEncoding: true,
	pause: true,
	resume: true,
	pipe: true,
	addListener: true,
	on: true,
	once: true,
	removeListener: true,
	removeAllListeners: true,
	setMaxListeners: true,
	listeners: true,
	emit: true
}

// defines properties from http.ServerResponse (own and inherited) that will be
// exposed to the haiku-http handler

var serverResponseSandbox = { 
	writable: true,
	writeHead: true,
	statusCode: true,
	removeHeader: true,
	write: true,
	addTrailers: true,
	end: true,
	addListener: true,
	on: true,
	once: true,
	removeListener: true,
	removeAllListeners: true,
	setMaxListeners: true,
	listeners: true,
	emit: true
}

// wrap a function on an object with another function
// the wrapped function will be passed as the last argument to the wrapping function
// wrapping function is called in the context of the instance the wrapped function belongs to

function wrapFunction(instance, func, wrapperFunc) {
	var oldFunc = instance[func];
	return function () {
		arguments[arguments.length++] = oldFunc;
		return wrapperFunc.apply(instance, arguments);
	}
}

// wrap a function to invoke an inspector function immediately after
// execution of the wrapped function

function addPostInspector(instance, func, inspector) {
	return wrapFunction(instance, func, function () {
		var result = arguments[--arguments.length].apply(this, arguments);
		inspector(arguments, result);
		return result;
	})
}

// wrap http.{request|get} to return a sandboxed http.ClientRequest

function wrapHttpRequest(object, parent, nameOnParent, executionContext) {
	return wrapFunction(parent, nameOnParent, function () {
		var clientRequest = arguments[--arguments.length].apply(this, arguments);
		return createObjectSandbox(clientRequestSandbox, clientRequest);
	});
}

// wrap http.ClientRequest.{on|once|addListener}('response', ...) to return a sandboxed http.ClientResponse

function wrapResponseEvent(object, parent, nameOnParent, executionContext) {
	return wrapFunction(parent, nameOnParent, function (type, listener) {
		console.log('wrapping event ' + type)
		var oldFunc = arguments[--arguments.length];
		if ('response' === type) {
			// intercept 'response' event subscription and sandbox the response
			// TODO this wrapping will make removeListener break
			oldFunc('request', function(res) {
				listener(createObjectSandbox(clientResposeSandbox, res));
			})
		}
		else
			// pass-through for all other event types
			return oldFunc.apply(this, arguments);
	});
}

function createObjectSandbox(sandbox, object, parent, nameOnParent, executionContext) {
	if (typeof sandbox === 'function') {
		// custom sandboxing logic
		return sandbox(object, parent, nameOnParent, executionContext);
	}
	else if (true === sandbox) {
		if (typeof object === 'function')
			// wrap functions to avoid leaking prototypes, constructors, and arguments
			return function () { return object.apply(executionContext, arguments); }
		else 
			// "security treat as safe", return back without wrapping 
			return object;
	} 
	else {

		// sandbox properties owned by object and properties inherited from the prototype chain
		// this flattens out the properties inherited from the prototype chain onto
		// a single result object; any code that depends on the existence of the prototype chain
		// will likely be broken by this, but any code that just invokes the members will continue
		// working

		var result = {};
		var current = object;
		while (current) {
			for (var element in sandbox) 
				if (!result[element] && current[element]) // preserve inheritance chain
					result[element] = createObjectSandbox(sandbox[element], current[element], current, element, object);
			current = Object.getPrototypeOf(current);
		}

		return result;
	}
}

// sandbox the 'require' method: if a module is on a whitelist, create a sanboxed instance
// otherwise throw

function sandboxedRequire(name) {
	if (moduleSandbox[name])
		return createObjectSandbox(moduleSandbox[name], require.apply(this, arguments));
	else
		throw 'Module ' + name + ' is not available in the haiku-http sandbox.'
}

function createSandbox(context) {

	// limit execution time of the handler to the preconfigured value

	context.timeout = setTimeout(function () {
		delete context.timeout;
		haikuError(context, 500, 'Handler ' + context.handlerName + ' did not complete within the time limit of ' + argv.t + 'ms');
		onRequestFinished(context);
	}, argv.t); // handler processing timeout

	// intercept end of response to speed up shutdown if in progress

	context.res.end = addPostInspector(context.res, 'end', function () {
		if (context.timeout) {
			clearTimeout(context.timeout);
			delete context.timeout;
			onRequestFinished(context);
		}
	});

	return {
		req: createObjectSandbox(serverRequestSandbox, context.req),
		res: createObjectSandbox(serverResponseSandbox, context.res),
		setTimeout: setTimeout,
		console: console,
		require: sandboxedRequire,
		stdout: process.stdout
	};	
}

function executeHandler(context) {
	log(new Date() + ' executing ' + context.handlerName);

	context.req.resume();
	try {
		vm.runInNewContext(context.handler, createSandbox(context), context.handlerName);
	}
	catch (e) {
		haikuError(context, 500, 'Handler ' + context.handlerName + ' generated an exception at runtime:\n' 
			+ (e.message || e) + '\n'
			+ (e.stack || ''));
	}
}

function resolveHandler(context) {
	if (!context.handlerName)
		return haikuError(context, 400, 
			'The x-haiku-handler HTTP request header or query paramater must specify the URL of the scriptlet to run.');

	try {
		context.handlerUrl = url.parse(context.handlerName);
	}
	catch (e) {
		return haikuError(context, 400, 'The x-haiku-handler parameter must be a valid URL that resolves to a JavaScript scriptlet.');
	}

	var engine;
	if (context.handlerUrl.protocol === 'http:') {
		engine = http;
		context.handlerUrl.port = context.handlerUrl.port || 80;
	}
	else if (context.handlerUrl.protocol === 'https:') {
		engine = https;
		context.handlerUrl.port = context.handlerUrl.port || 443;
	}
	else
		return haikuError(context, 400, 'The x-haiku-handler parameter specifies unsupported protocol. Only http and https are supported.');
	
	var handlerRequest;
    var processResponse = function(res) {
        context.handler = '';
        var length = 0;
        res.on('data', function(chunk) {
        	length += chunk.length;
        	if (length > argv.i) {
        		handlerRequest.abort();
        		return haikuError(context, 400, 'The size of the handler exceeded the quota of ' + argv.i + ' bytes.');
        	}
            context.handler += chunk;
        })           
        .on('end', function() {
            if (res.statusCode === 200)
            	executeHandler(context);
            else if (res.statusCode === 302 && context.redirect < 3) {
            	context.handlerName = res.headers['location'];
            	context.redirect++;
            	resolveHandler(context);
            } 
            else 
                return haikuError(context, 400, 'HTTP error when obtaining handler code from ' + context.handlerName + ': ' + res.statusCode);
        }); 
    }

    var processError = function(error) {
        haikuError(context, 400, 'Unable to obtain HTTP handler code from ' + context.handlerName + ': ' + error);
    }

    if (argv.proxyHost) {
         // HTTPS or HTTP request through HTTP proxy
        http.request({ // establishing a tunnel
          host: argv.proxyHost,
          port: argv.proxyPort,
          method: 'CONNECT',
          path: context.handlerUrl.hostname + ':' + context.handlerUrl.port
        }).on('connect', function(pres, socket, head) {
            if (pres.statusCode !== 200) 
                return haikuError(context, 400, 'Unable to connect to the host ' + context.host);
            else 
                handlerRequest = engine.get({
                    host: context.handlerUrl.host,
                    path: context.handlerUrl.path,
                    socket: socket, // using a tunnel
                    agent: false    // cannot use a default agent
                }, processResponse).on('error', processError);
        }).on('error', processError).end();
    }
    else // no proxy
        handlerRequest = engine.get({
	        host: context.handlerUrl.host,
	        path: context.handlerUrl.path
        }, processResponse).on('error', processError);
}

function processRequest(req, res) {

	activeRequests++;

	if (!shutdownInProgress && argv.r > 0 && ++requestCount >= argv.r) {
		log('Entering shutdown mode after reaching request quota. Current active requests: ' + activeRequests);
		initiateShutdown();
	}

	req.pause();
	resolveHandler({ 
		req: req, 
		res: res, 
		redirect: 0,
		handlerName: req.headers['x-haiku-handler'] || url.parse(req.url, true).query['x-haiku-handler']
	});
}

exports.main = function(args) {
	argv = args;
	httpServer = http.createServer(processRequest).listen(argv.p);
	httpsServer = https.createServer({ cert: argv.cert, key: argv.key }, processRequest).listen(argv.s);
}
