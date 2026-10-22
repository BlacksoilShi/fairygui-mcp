"""An unnamed, non-inherited Windows job owns only the child handle we spawn.

No arbitrary PID termination API is exposed. Kill-on-close is lifecycle ownership,
not a security sandbox. See official Win32 API references in PREVIEW_MAINTENANCE.md.
"""
import ctypes,os

class OwnedProcesses:
    def __init__(self):
        self.handle=None;self.windows=os.name=='nt'
        if not self.windows:return
        from ctypes import wintypes as W
        class Basic(ctypes.Structure):
            _fields_=[('processTime',ctypes.c_longlong),('jobTime',ctypes.c_longlong),('flags',W.DWORD),('minWorking',ctypes.c_size_t),('maxWorking',ctypes.c_size_t),('activeLimit',W.DWORD),('affinity',ctypes.c_size_t),('priority',W.DWORD),('scheduling',W.DWORD)]
        class Extended(ctypes.Structure):
            _fields_=[('basic',Basic),('io',ctypes.c_ulonglong*6),('processMemory',ctypes.c_size_t),('jobMemory',ctypes.c_size_t),('peakProcess',ctypes.c_size_t),('peakJob',ctypes.c_size_t)]
        k=ctypes.WinDLL('kernel32',use_last_error=True);self.k=k
        k.CreateJobObjectW.argtypes=[ctypes.c_void_p,W.LPCWSTR];k.CreateJobObjectW.restype=W.HANDLE
        k.SetInformationJobObject.argtypes=[W.HANDLE,ctypes.c_int,ctypes.c_void_p,W.DWORD];k.SetInformationJobObject.restype=W.BOOL
        k.AssignProcessToJobObject.argtypes=[W.HANDLE,W.HANDLE];k.AssignProcessToJobObject.restype=W.BOOL
        k.QueryInformationJobObject.argtypes=[W.HANDLE,ctypes.c_int,ctypes.c_void_p,W.DWORD,ctypes.POINTER(W.DWORD)];k.QueryInformationJobObject.restype=W.BOOL
        k.CloseHandle.argtypes=[W.HANDLE];k.CloseHandle.restype=W.BOOL
        h=k.CreateJobObjectW(None,None)
        if not h:raise ctypes.WinError(ctypes.get_last_error())
        info=Extended();info.basic.flags=0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, not breakaway.
        if not k.SetInformationJobObject(h,9,ctypes.byref(info),ctypes.sizeof(info)):
            error=ctypes.get_last_error();k.CloseHandle(h);raise ctypes.WinError(error)
        self.handle=h
    def assign(self,process):
        if self.windows:
            if not self.handle or not self.k.AssignProcessToJobObject(self.handle,int(process._handle)):raise ctypes.WinError(ctypes.get_last_error())
    def pids(self):
        if not self.windows or not self.handle:return []
        from ctypes import wintypes as W
        class Pids(ctypes.Structure):_fields_=[('assigned',W.DWORD),('count',W.DWORD),('ids',ctypes.c_size_t*128)]
        result=Pids();size=W.DWORD()
        if not self.k.QueryInformationJobObject(self.handle,3,ctypes.byref(result),ctypes.sizeof(result),ctypes.byref(size)):raise ctypes.WinError(ctypes.get_last_error())
        if result.assigned>128 or result.count>128:raise ValueError('Owned process observation exceeds128')
        return list(result.ids[:result.count])
    def close(self):
        if self.handle:
            h=self.handle;self.handle=None
            if not self.k.CloseHandle(h):raise ctypes.WinError(ctypes.get_last_error())
