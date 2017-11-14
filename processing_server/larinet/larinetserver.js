var exports = module.exports = {};
//var base64_arraybuffer=require('base64-arraybuffer');

var m_job_manager=new JobManager();

var CLP=new CLParams(process.argv);

var config=read_json_file(__dirname+'/larinet.user.json')||{};
var data_directory=CLP.namedParameters['data_directory']||config.data_directory||'';
if (!('download_base_url' in config)) {
	config.download_base_url="${base}/raw";
}
var download_base_url=config.download_base_url||'';
var prv_exe='prv';
var mp_exe='mproc';

var handler_opts={};
exports.handler_opts=handler_opts;

if (!data_directory) {
	console.log ('warning: data_directory is empty.');
	return;
}
console.log ('Using data_directory='+data_directory);

handler_opts.prv_exe=prv_exe;
handler_opts.mp_exe=mp_exe;
handler_opts.data_directory=data_directory;
handler_opts.download_base_url=download_base_url;

function JobManager() {
	var that=this;

	this.addJob=function(process_id,J) {m_queued_jobs[process_id]=J;};
	this.job=function(process_id) {if (process_id in m_queued_jobs) return m_queued_jobs[process_id]; else return null;};
	this.removeJob=function(process_id) {removeJob(process_id);};

	var m_queued_jobs={};

	function housekeeping() {
		/*
		for (var id in m_queued_jobs) {
			if (m_queued_jobs[id].elapsedSinceKeepAlive()>60000) {
				console.log ('deleting old job record');
				removeJob(id);
			}
		}
		*/
		setTimeout(housekeeping,10000);	
	}
	//setTimeout(housekeeping,10000);	
	function removeJob(process_id) {
		delete m_queued_jobs[process_id];
	}
	
}

function QueuedJob() {
	var that=this;

	this.start=function(processor_name,inputs,outputs,parameters,resources,opts,callback) {start(processor_name,inputs,outputs,parameters,resources,opts,callback);};
	this.keepAlive=function() {m_alive_timer=new Date();};
	this.cancel=function(callback) {cancel(callback);};
	this.isComplete=function() {return m_is_complete;};
	this.result=function() {return m_result;};
	this.elapsedSinceKeepAlive=function() {return (new Date())-m_alive_timer;};
	this.outputFilesStillValid=function() {return outputFilesStillValid();};

	var m_result=null;
	var m_alive_timer=new Date();
	var m_is_complete=false;
	var m_ppp=null;
	var m_output_file_stats={};
	var hopts=handler_opts;

	var request_fname,response_fname,mpreq;
	function start(processor_name,inputs,outputs,parameters,resources,opts,callback) {
		request_fname=make_tmp_json_file(hopts.data_directory);
		response_fname=make_tmp_json_file(hopts.data_directory);
		mpreq={action:'queue_process',processor_name:processor_name,inputs:inputs,outputs:outputs,parameters:parameters,resources:resources};
		if (!write_text_file(request_fname,JSON.stringify(mpreq))) {
			callback({success:false,error:'Problem writing mpreq to file'});
			return;
		}
		callback({success:true});
		setTimeout(start2,10);
	}
	function start2() {
		setTimeout(housekeeping,1000);
		m_ppp=run_process_and_read_stdout(hopts.mp_exe,['handle-request','--prvbucket_path='+hopts.data_directory,request_fname,response_fname],function(txt) {
			remove_file(request_fname);
			if (!require('fs').existsSync(response_fname)) {
				m_is_complete=true;
				m_result={success:false,error:'Response file does not exist: '+response_fname};
				return;
			}
			var json_response=read_json_file(response_fname);
			remove_file(response_fname);
			if (json_response) {
				m_is_complete=true;
				m_result=json_response;
				m_output_file_stats=compute_output_file_stats(m_result.outputs);
			}
			else {
				m_is_complete=true;
				m_result={success:false,error:'unable to parse json in response file'};
			}
		});
	}
	function cancel(callback) {
		if (m_is_complete) {
			callback({success:true}); //already complete
			return;
		}
		if (m_ppp) {
			console.log ('Canceling process: '+m_ppp.pid);
			m_ppp.stdout.pause();
			m_ppp.kill('SIGTERM');
			m_is_complete=true;
			m_result={success:false,error:'Process canceled'};
			if (callback) callback({success:true});
		}
		else {
			if (callback) callback({success:false,error:'m_ppp is null.'});
		}
	}
	function housekeeping() {
		if (m_is_complete) return;
		var timeout=20000;
		var elapsed_since_keep_alive=that.elapsedSinceKeepAlive();
		if (elapsed_since_keep_alive>timeout) {
			console.log ('Canceling process due to keep-alive timeout');
			cancel();
		}
		else {
			setTimeout(housekeeping,1000);
		}
	}
	function make_tmp_json_file(data_directory) {
		return data_directory+'/tmp.'+make_random_id(10)+'.json';
	}
	function make_random_id(len) {
	    var text = "";
	    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

	    for( var i=0; i < len; i++ )
	        text += possible.charAt(Math.floor(Math.random() * possible.length));

	    return text;
	}
	function compute_output_file_stats(outputs) {
		var stats={};
		for (var key in outputs) {
			stats[key]=compute_output_file_stat(outputs[key].original_path);
		}
		return stats;
	}
	function compute_output_file_stat(path) {
		try {
			var ss=require('fs').statSync(path);
			return {
				exists:require('fs').existsSync(path),
				size:ss.size,
				last_modified:(ss.mtime+'') //make it a string
			};
		}	
		catch(err) {
			return {};
		}
	}
	function outputFilesStillValid() {
		var outputs0=(m_result||{}).outputs||{};
		var stats0=m_output_file_stats||{};
		var stats1=compute_output_file_stats(outputs0);
		for (var key in stats0) {
			var stat0=stats0[key]||{};
			var stat1=stats1[key]||{};
			if (!stat1.exists) {
				return false;
			}
			if (stat1.size!=stat0.size) {
				return false;
			}
			if (stat1.last_modified!=stat0.last_modified) {
				return false;
			}
		}
		return true;
	}
}

function larinetserver(req,onclose,callback) {
	var hopts=handler_opts;
	var action=req.a||'';
	if (!action) {
		callback({success:false,error:'Empty action.'});
		return;
	}

	//console.log (JSON.stringify(req));

	if (action=='prv-locate') {
		prv_locate(req,onclose,function(resp) {
			callback(resp);
		});
	}
	else if (action=='prv-upload') {
		prv_upload(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='queue-process') {
		queue_process(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='probe-process') {
		probe_process(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='cancel-process') {
		cancel_process(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='processor-spec') {
		processor_spec(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='start-download') {
		start_download(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='probe-download') {
		probe_download(req,function(resp) {
			callback(resp);
		});
	}
	else if (action=='cancel-download') {
		cancel_download(req,function(resp) {
			callback(resp);
		});
	}
	else {
		callback({success:false,error:'Unexpected action: '+action});
	}

	function prv_locate(query,onclose,callback) {
		if (query.user_storage) {
			if ((!query.userid)||(!query.filename)) {
				callback({success:false,error:'invalid query'});
				return;
			}
			var userid_encoded=new Buffer(query.userid).toString('base64');
			var filename_encoded=new Buffer(query.filename).toString('base64');
			var file_path=user_storage_directory(userid_encoded,false)+'/'+filename_encoded;
			if (!require('fs').existsSync(file_path)) {
				console.log ('not found: '+file_path);
				callback({success:true,found:false,userid_encoded:userid_encoded});
				return;
			}
			var txt=file_path.slice(hopts.data_directory.length+1);
			var resp={success:true,found:true,path:txt,full_path:file_path};
			if (hopts.download_base_url) {
				resp.url=hopts.download_base_url+'/'+resp.path;
			}
			callback(resp);
			return;
		}
		if ((!query.checksum)||(!('size' in query))||(!('fcs' in query))) {
			if (callback) {
				callback({success:false,error:"Invalid query."});	
				callback=null;
			}
			return;
		}
		var ppp=run_process_and_read_stdout(hopts.prv_exe,['locate','--search_path='+hopts.data_directory,'--checksum='+query.checksum,'--size='+query.size,'--fcs='+(query.fcs||'')],function(txt) {
			txt=txt.trim();
			if (!starts_with(txt,hopts.data_directory+'/')) {
				if (callback) callback({success:true,found:false});
				callback=null;
				return;
			}
			var full_path=txt;
			txt=txt.slice(hopts.data_directory.length+1);
			var resp={success:true,found:true,path:txt,full_path:full_path};
			if (hopts.download_base_url)
				resp.url=hopts.download_base_url+'/'+resp.path;
			if (callback) callback(resp);
			callback=null;
		});
		onclose(function() {
			console.log ('Ending prv-locate command...');
			ppp.stdout.pause();
			ppp.kill('SIGKILL');
			if (callback) callback({success:false,error:'Ended prv-locate command'});
			callback=null;
		});
	}
	function prv_upload(query,callback) {
		if (!query.size) {
			callback({success:false,error:"Invalid query."});	
			return;
		}
		if (!query.data_base64) {
			callback({success:false,error:"Invalid query. Missing data_base64."});	
			return;	
		}
		//var buf = base64_arraybuffer.decode(query.data_base64);
		var buf = new Buffer(query.data_base64,'base64');;
		var fname;
		if (query.user_storage) {
			if ((!query.userid)||(!query.filename)) {
				callback({success:false,error:'invalid query'});
				return;
			}
			if ((query.userid.length>80)||(query.filename.length>80)) {
				callback({success:false,error:'userid or filename is too long'});
				return;
			}
			var userid_encoded=new Buffer(query.userid).toString('base64');
			var filename_encoded=new Buffer(query.filename).toString('base64');
			fname=user_storage_directory(userid_encoded,true)+'/'+filename_encoded;
		}
		else {
			fname=uploads_directory(true)+"/"+make_random_id(10)+'.dat';
		}
		require('fs').writeFile(fname,buf,function(err) {
			if (err) {
				callback({success:false,error:'Problem writing file: '+err.message});
				return;
			}
			run_process_and_read_stdout(hopts.prv_exe,['stat',fname],function(txt) {
				txt=txt.trim();
				var stat=null;
				try {
					stat=JSON.parse(txt);
				}
				catch(err) {
					callback({success:false,error:'Problem parsing json from prv stat'});
					return;
				}
				if (stat.size!=req.size) {
					callback({success:false,error:'Unexpected size of new file: '+stat.size+' <> '+req.size});
					return;	
				}
				callback({success:true,prv_stat:stat});
			});
		});	
	}
	function queue_process(query,callback) {
		var processor_name=query.processor_name||'';
		var inputs=query.inputs||{};
		var outputs=query.outputs||{};
		var parameters=query.parameters||{};
		var resources=query.resources||{};
		var opts=query.opts||{};
		var process_id;
		if (query.process_id) {
			process_id=query.process_id;
			var J=m_job_manager.job(query.process_id);
			if (J) {
				if (J.isComplete()) {
					if (!J.result().success) {
						//complete but not successful -- start over
						m_job_manager.removeJob(J);
						do_queue_process(); //start over	
					}
					else if (('cache_output' in opts)&&(!opts.cache_output)) {
						m_job_manager.removeJob(J);
						do_queue_process(); //start over		
					}
					else if (J.outputFilesStillValid()) {
						//already complete and the output files are still valid
						var resp=make_response_for_J(process_id,J);
						callback(resp);		
					}
					else {
						//complete but the output files are no longer valid
						m_job_manager.removeJob(J);
						do_queue_process(); //start over		
					}
				}
				else {
					var resp=make_response_for_J(process_id,J);
					callback(resp);		
				}
			}
			else {
				do_queue_process();
			}
		}
		else {
			process_id=make_random_id(10);
			do_queue_process();
		}
		function do_queue_process() {
			var Jnew=new QueuedJob();
			Jnew.start(processor_name,inputs,outputs,parameters,resources,opts,function(tmp) {
				if (!tmp.success) {
					callback(tmp);
					return;
				}
				m_job_manager.addJob(process_id,Jnew);
				var check_timer=new Date();
				check_it();
				function check_it() {
					var elapsed=(new Date()) -check_timer;
					if ((elapsed>=Number(query.wait_msec))||(Jnew.isComplete())) {
						var resp=make_response_for_J(process_id,Jnew);
						callback(resp);	
					}
					else {
						setTimeout(check_it,10);
					}
				}
			});	
		}
		
	}
	function probe_process(query,callback) {
		var process_id=query.process_id||'';
		var J=m_job_manager.job(process_id);
		if (!J) {
			callback({success:false,error:'Process id not found: '+process_id});
			return;
		}
		J.keepAlive();
		var resp=make_response_for_J(process_id,J);
		callback(resp);
		
	}
	function cancel_process(query,callback) {
		var process_id=query.process_id||'';
		var J=m_job_manager.job(process_id);
		if (!J) {
			callback({success:false,error:'Process id not found: '+process_id});
			return;
		}
		J.cancel(callback);
	}
	function start_download(query,callback) {
		var address=query.address||'';
		var ticket=query.ticket||'';
		var sha1=query.sha1||'';
		if ((!ticket)||(!sha1)) {
			callback({success:false,error:'Missing ticket or sha1'});
			return;
		}
		var download_id=make_random_id(10);
		query.wait_msec=query.wait_msec||0;
		var Dnew=new Download();
		Dnew.start(address,{ticket:ticket,sha1:sha1},function(tmp) {
			if (!tmp.success) {
				callback(tmp);
				return;
			}
			m_download_manager.addDownload(download_id,Dnew);
			var check_timer=new Date();
			check_it();
			function check_it() {
				var elapsed=(new Date()) -check_timer;
				if ((elapsed>=Number(query.wait_msec))||(Dnew.isComplete())) {
					var resp=make_response_for_D(download_id,Dnew);
					callback(resp);	
				}
				else {
					setTimeout(check_it,10);
				}
			}
		});
	}
	function probe_download(query,callback) {
		var download_id=query.download_id||'';
		var D=m_download_manager.download(download_id);
		if (!D) {
			callback({success:false,error:'Download with id not found: '+download_id});
			return;
		}
		D.keepAlive();
		var resp=make_response_for_D(download_id,D);
		callback(resp);
	}
	function cancel_download(query,callback) {
		var download_id=query.download_id||'';
		var D=m_download_manager.download(download_id);
		if (!D) {
			callback({success:false,error:'Download with id not found: '+download_id});
			return;
		}
		D.cancel(callback);
	}
	function processor_spec(query,callback) {
		var req_fname=make_tmp_json_file(hopts.data_directory);
		var resp_fname=make_tmp_json_file(hopts.data_directory);
		var req={action:'processor_spec'};
		if (!write_text_file(req_fname,JSON.stringify(req))) {
			callback({success:false,error:'Problem writing req to file'});
			return;
		}
		var ppp=run_process_and_read_stdout(hopts.mp_exe,['handle-request',req_fname,resp_fname],function(txt) {
			remove_file(req_fname);
			if (!require('fs').existsSync(resp_fname)) {
				callback({success:false,error:'Response file does not exist: '+resp_fname});
				return;
			}
			var json_response=read_json_file(resp_fname);
			remove_file(resp_fname);
			if (json_response) {
				callback(json_response);
			}
			else {
				callback({success:false,error:'unable to parse json in response file'});
			}
		});
	}
	function make_response_for_J(process_id,J) {
		var resp={success:true};
		resp.process_id=process_id;
		resp.complete=J.isComplete();
		if (J.isComplete())
			resp.result=J.result();
		//callback(resp); //fixed on 10/6/17 by jfm (before we were returning undefined)
		return resp;
	}
	function make_response_for_D(download_id,D) {
		var resp={success:true};
		resp.download_id=download_id;
		resp.complete=D.isComplete();
		if (D.isComplete())
			resp.result=D.result();
		return resp;
	}

	function starts_with(str,substr) {
		return (str.slice(0,substr.length)==substr);
	}
	
	function uploads_directory(create_if_needed) {
		var ret=hopts.data_directory+"/_uploads";
		if (create_if_needed) {
			try {require('fs').mkdirSync(ret);} catch(err) {}
		}
		return ret;
	}
	function user_storage_directory(userid_encoded,create_if_needed) {
		var ret=hopts.data_directory+'/_user_storage';
		if (create_if_needed) {
			try {require('fs').mkdirSync(ret);} catch(err) {}
		}
		ret+='/'+userid_encoded;
		if (create_if_needed) {
			try {require('fs').mkdirSync(ret);} catch(err) {}
		}
		return ret;
	}
	function make_tmp_json_file(data_directory) {
		return data_directory+'/tmp.'+make_random_id(10)+'.json';
	}
	function make_random_id(len) {
	    var text = "";
	    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

	    for( var i=0; i < len; i++ )
	        text += possible.charAt(Math.floor(Math.random() * possible.length));

	    return text;
	}
}


exports.larinetserver=larinetserver;

exports.RequestHandler=function() {
	var hopts=handler_opts;
	this.handle_request=function(REQ,RESP) {
		//parse the url of the request
		var url_parts = require('url').parse(REQ.url,true);
		var host=url_parts.host;
		var path=url_parts.pathname;
		var query=url_parts.query;

		if (REQ.method == 'OPTIONS') {
			var headers = {};
			
			//allow cross-domain requests
			/// TODO refine this
			
			headers["Access-Control-Allow-Origin"] = "*";
			headers["Access-Control-Allow-Methods"] = "POST, GET, PUT, DELETE, OPTIONS";
			headers["Access-Control-Allow-Credentials"] = false;
			headers["Access-Control-Max-Age"] = '86400'; // 24 hours
			headers["Access-Control-Allow-Headers"] = "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept";
			RESP.writeHead(200, headers);
			RESP.end();
		}
		else if (REQ.method=='GET') {
			console.log ('GET: '+REQ.url);
			var onclose0=function(to_run_on_close) {
				REQ.on('close',function() {
					to_run_on_close();
				});
			}
			larinetserver(query,onclose0,function(resp) {
				if (resp) send_json_response(resp);
			},hopts);
		}
		else if(REQ.method=='POST') {
			receive_json_post(REQ,function(obj) {
				if (!obj) {
					var err='Problem parsing json from post';
					console.log (err);
					send_json_response({success:false,error:err});
					return;
				}
				var onclose0=function(to_run_on_close) {
					REQ.on('close',function() {
						to_run_on_close();
					});
				}
				larinetserver(obj,onclose0,function(resp) {
					if (resp) send_json_response(resp);
				},hopts);
			});
		}
		else {
			send_text_response("Unsuported request method.");
		}
		
		function send_json_response(obj) {
			console.log ('RESPONSE: '+JSON.stringify(obj));
			RESP.writeHead(200, {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"});
			RESP.end(JSON.stringify(obj));
		}
		function send_text_response(text) {
			console.log ('RESPONSE: '+text);
			RESP.writeHead(200, {"Access-Control-Allow-Origin":"*", "Content-Type":"text/plain"});
			RESP.end(text);
		}
		function send_html_response(text) {
			console.log ('RESPONSE: '+text);
			RESP.writeHead(200, {"Access-Control-Allow-Origin":"*", "Content-Type":"text/html"});
			RESP.end(text);
		}

		
		
	};
};

function run_process_and_read_stdout(exe,args,callback) {
	//console.log ('RUNNING:'+exe+' '+args.join(' '));
	var P;
	try {
		P=require('child_process').spawn(exe,args);
	}
	catch(err) {
		console.log (err);
		callback('',-1,"Problem launching: "+exe+" "+args.join(" "));
		return;
	}
	var txt='';
	P.stdout.on('data',function(chunk) {
		txt+=chunk;
	});
	P.on('close',function(code) {
		callback(txt,code,'');
	});
	return P;
}

function write_text_file(fname,txt) {
	try {
		require('fs').writeFileSync(fname,txt);
		return true;
	}
	catch(err) {
		return false;
	}
}

function read_text_file(fname) {
	try {
		return require('fs').readFileSync(fname,'utf8');
	}
	catch(err) {
		return '';
	}
}

function read_json_file(fname) {
	try {
		return JSON.parse(read_text_file(fname));
	}
	catch(err) {
		return '';
	}	
}

function remove_file(fname) {
	try {
		require('fs').unlinkSync(fname);
		return true;
	}
	catch(err) {
		return false;
	}
}

function receive_json_post(REQ,callback_in) {
	var callback=callback_in;
	var body='';
	REQ.on('data',function(data) {
		body+=data;
	});
	REQ.on('error',function() {
		if (callback) callback(null);
		callback=null;
	})
	
	REQ.on('end',function() {
		var obj;
		try {
			var obj=JSON.parse(body);
		}
		catch (e) {
			if (callback) callback(null);
			callback=null;
			return;
		}
		if (callback) callback(obj);
		callback=null;
	});
}


function DownloadManager() {
	var that=this;

	this.addDownload=function(download_id,D) {m_downloads[download_id]=D;};
	this.download=function(download_id) {if (download_id in m_downloads) return m_downloads[download_id]; else return null;};
	this.removeDownload=function(download_id) {removeDownload(download_id);};

	var m_downloads={};

	function removeDownload(download_id) {
		delete m_downloads[download_id];
	}
	
}

function Download() {
	var that=this;

	this.start=function(address,opts,callback) {start(address,opts,callback);};
	this.keepAlive=function() {m_alive_timer=new Date();};
	this.cancel=function(callback) {cancel(callback);};
	this.isComplete=function() {return m_is_complete;};
	this.result=function() {return m_result;};
	this.elapsedSinceKeepAlive=function() {return (new Date())-m_alive_timer;};

	var m_result=null;
	var m_alive_timer=new Date();
	var m_is_complete=false;
	var m_ppp=null;
	var hopts=handler_opts;

	function start(address,opts,callback) {
		setTimeout(housekeeping,1000);
		var exe='mlcp';
		try {require('fs').mkdirSync(hopts.data_directory+'/_downloads');} catch(err) {}
		var sha1=opts.sha1;
		var output_fname=hopts.data_directory+'/_downloads/'+sha1;
		m_ppp=run_process_and_read_stdout(exe,[address,output_fname,'--ticket='+opts.ticket],function(txt,code,err) {
			if (code==0) {
				if (!require('fs').existsSync(output_fname)) {
					if (callback) callback({success:false,error:'Output file does not exist: '+output_fname}); callback=0;
					m_is_complete=true;
					return;
				}
				if (callback) callback({success:true}); callback=0;
				m_is_complete=true;
			}
			else {
				console.log (txt);
				if (callback) callback({success:false}); callback='Exit code for mlcp is not zero in download: '+code+': '+err;	callback=0;
				m_is_complete=true;
			}
		});
	}
	function cancel(callback) {
		if (m_is_complete) {
			callback({success:true}); //already complete
			return;
		}
		if (m_ppp) {
			console.log ('Canceling download process: '+m_ppp.pid);
			m_ppp.stdout.pause();
			m_ppp.kill('SIGTERM');
			m_is_complete=true;
			m_result={success:false,error:'Download process canceled'};
			if (callback) callback({success:true});
		}
		else {
			if (callback) callback({success:false,error:'m_ppp is null.'});
		}
	}
	function housekeeping() {
		if (m_is_complete) return;
		var timeout=20000;
		var elapsed_since_keep_alive=that.elapsedSinceKeepAlive();
		if (elapsed_since_keep_alive>timeout) {
			console.log ('Canceling download due to keep-alive timeout');
			cancel();
		}
		else {
			setTimeout(housekeeping,1000);
		}
	}
}

function CLParams(argv) {
	this.unnamedParameters=[];
	this.namedParameters={};

	var args=argv.slice(2);
	for (var i=0; i<args.length; i++) {
		var arg0=args[i];
		if (arg0.indexOf('--')===0) {
			arg0=arg0.slice(2);
			var ind=arg0.indexOf('=');
			if (ind>=0) {
				this.namedParameters[arg0.slice(0,ind)]=arg0.slice(ind+1);
			}
			else {
				//this.namedParameters[arg0]=args[i+1]||'';
				//i++;
				this.namedParameters[arg0]='';
			}
		}
		else if (arg0.indexOf('-')===0) {
			arg0=arg0.slice(1);
			this.namedParameters[arg0]='';
		}
		else {
			this.unnamedParameters.push(arg0);
		}
	}
};
