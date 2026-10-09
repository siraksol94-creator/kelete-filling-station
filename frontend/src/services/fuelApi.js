import api from './api';

// Fuel grades
export const getFuelGrades      = ()        => api.get('/fuel-grades');
export const createFuelGrade    = (data)    => api.post('/fuel-grades', data);
export const updateFuelGrade    = (id, d)   => api.put(`/fuel-grades/${id}`, d);
export const deleteFuelGrade    = (id)      => api.delete(`/fuel-grades/${id}`);

// Tank groups
export const getTankGroups      = ()        => api.get('/tank-groups');
export const createTankGroup    = (d)       => api.post('/tank-groups', d);
export const updateTankGroup    = (id, d)   => api.put(`/tank-groups/${id}`, d);
export const deleteTankGroup    = (id)      => api.delete(`/tank-groups/${id}`);
export const assignTanksToGroup = (id, tank_ids) => api.post(`/tank-groups/${id}/assign`, { tank_ids });
export const unassignTanks      = (tank_ids) => api.post(`/tank-groups/unassign`, { tank_ids });

// Tanks
export const getTanks           = ()        => api.get('/tanks');
export const getTank            = (id)      => api.get(`/tanks/${id}`);
export const createTank         = (d)       => api.post('/tanks', d);
export const updateTank         = (id, d)   => api.put(`/tanks/${id}`, d);
export const deleteTank         = (id)      => api.delete(`/tanks/${id}`);
export const dipTank            = (id, d)   => api.post(`/tanks/${id}/dip`, d);

// Pumps + nozzles
export const getPumpsWithNozzles = ()        => api.get('/pumps');
export const createPump         = (d)       => api.post('/pumps', d);
export const updatePump         = (id, d)   => api.put(`/pumps/${id}`, d);
export const deletePump         = (id)      => api.delete(`/pumps/${id}`);
export const getNozzles         = ()        => api.get('/pumps/nozzles/list');
export const createNozzle       = (d)       => api.post('/pumps/nozzles', d);
export const updateNozzle       = (id, d)   => api.put(`/pumps/nozzles/${id}`, d);
export const deleteNozzle       = (id)      => api.delete(`/pumps/nozzles/${id}`);

// Fleet customers + vehicles
export const getFleetCustomers  = ()        => api.get('/fleet-customers');
export const getFleetCustomer   = (id)      => api.get(`/fleet-customers/${id}`);
export const createFleetCustomer = (d)      => api.post('/fleet-customers', d);
export const updateFleetCustomer = (id, d)  => api.put(`/fleet-customers/${id}`, d);
export const deleteFleetCustomer = (id)     => api.delete(`/fleet-customers/${id}`);
export const addFleetVehicle    = (fcId, d) => api.post(`/fleet-customers/${fcId}/vehicles`, d);
export const updateFleetVehicle = (vid, d)  => api.put(`/fleet-customers/vehicles/${vid}`, d);
export const deleteFleetVehicle = (vid)     => api.delete(`/fleet-customers/vehicles/${vid}`);

// Fuel deliveries (GRN)
export const getFuelDeliveries  = ()        => api.get('/fuel-deliveries');
export const createFuelDelivery = (d)       => api.post('/fuel-deliveries', d);
export const deleteFuelDelivery = (id)      => api.delete(`/fuel-deliveries/${id}`);

// Attendant shifts
export const getShifts          = (params)  => api.get('/attendant-shifts', { params });
export const getCurrentShift    = ()        => api.get('/attendant-shifts/current');
export const getShift           = (id)      => api.get(`/attendant-shifts/${id}`);
export const openShift          = (d)       => api.post('/attendant-shifts/open', d);
export const closeShift         = (id, d)   => api.post(`/attendant-shifts/${id}/close`, d);

// Fuel sales
export const getFuelSales       = (params)  => api.get('/fuel-sales', { params });
export const createFuelSale     = (d)       => api.post('/fuel-sales', d);
export const deleteFuelSale     = (id)      => api.delete(`/fuel-sales/${id}`);
