import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDashboard } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import { FiDollarSign, FiShoppingCart, FiTrendingUp, FiPackage, FiAlertTriangle } from 'react-icons/fi';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const COLORS = ['#dc2626', '#f472b6', '#f97316', '#3b82f6', '#6b7280'];

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = new Date(dateStr + 'T00:00:00');
  return days[d.getDay()];
};

const emptyData = {
  todaySales: 0,
  totalOrders: 0,
  weeklyRevenue: 0,
  totalCustomers: 0,
  // v1.13.156 — stock value. atCost is the headline; itemsWithoutCost explains
  // a zero rather than leaving it looking like a broken card.
  stockValue: { atCost: 0, atRetail: 0, itemsWithoutCost: 0, itemsInStock: 0 },
  topProducts: [],
  lowStock: [],
  salesByCategory: [],
  salesTrend: [],
};

const Dashboard = () => {
  const { symbol: curSym } = useCurrency();
  const navigate = useNavigate();
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getDashboard();
        if (res.data && res.data.todaySales !== undefined) setData(res.data);
      } catch (err) {
        // keep zeros
      }
      setLoading(false);
    };
    fetchData();
  }, []);

  // Compute percentages for pie chart from real totals
  const categoryTotal = (data.salesByCategory || []).reduce((sum, c) => sum + (c.total || 0), 0);
  const categoryData = (data.salesByCategory || []).map(c => ({
    ...c,
    pct: categoryTotal > 0 ? Math.round((c.total / categoryTotal) * 100) : 0,
  }));

  const salesTrend = (data.salesTrend || []).map(row => ({
    ...row,
    date: formatDate(row.date) || row.date,
  }));

  if (loading) {
    return (
      <div className="page-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
        <div style={{ color: '#9ca3af', fontSize: 15 }}>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="page-content">
      {/* Summary Cards */}
      <div className="stat-cards">
        <div className="stat-card red">
          <div className="stat-icon"><FiDollarSign /></div>
          <div>
            <div className="stat-label">Today's Sales</div>
            <div className="stat-value">K {data.todaySales?.toLocaleString()}</div>
          </div>
        </div>
        <div className="stat-card blue">
          <div className="stat-icon"><FiShoppingCart /></div>
          <div>
            <div className="stat-label">Total Orders</div>
            <div className="stat-value">{data.totalOrders}</div>
          </div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiTrendingUp /></div>
          <div>
            <div className="stat-label">Weekly Revenue</div>
            <div className="stat-value">K {data.weeklyRevenue?.toLocaleString()}</div>
          </div>
        </div>
        {/* v1.13.156 — was Total Customers. Stock value is what the depot is
            holding, which is the number a manager actually acts on.

            AT COST is the headline: what the business paid for what is on the
            shelf. Retail sits underneath because it is the figure people
            expect to recognise.

            When cost is missing the card SAYS SO instead of printing a bare
            K0. Every depot's opening balance was loaded with cost 0, so zero
            is the correct answer today and would otherwise read as a bug. */}
        <div className="stat-card orange">
          <div className="stat-icon"><FiPackage /></div>
          <div style={{ minWidth: 0 }}>
            <div className="stat-label">Stock Value (at cost)</div>
            <div className="stat-value">
              K {Math.round(data.stockValue?.atCost || 0).toLocaleString()}
            </div>
            {data.stockValue?.itemsWithoutCost > 0 ? (
              <div style={{ fontSize: 11, opacity: 0.85, marginTop: 3 }}>
                ⚠ {data.stockValue.itemsWithoutCost} of {data.stockValue.itemsInStock} items have no cost
              </div>
            ) : (
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3 }}>
                at selling K {Math.round(data.stockValue?.atRetail || 0).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="dashboard-grid">
        {/* Sales Trend Chart */}
        <div className="chart-card">
          <h3>Sales Trend (This Week)</h3>
          {salesTrend.length === 0 ? (
            <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>No sales data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={salesTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" fontSize={12} stroke="#9ca3af" />
                <YAxis fontSize={12} stroke="#9ca3af" />
                <Tooltip formatter={(value) => [`${curSym} ${value.toLocaleString()}`, 'Sales']} />
                <Line type="monotone" dataKey="total" stroke="#dc2626" strokeWidth={2} dot={{ fill: '#dc2626', r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Sales by Category Pie */}
        <div className="chart-card">
          <h3>Sales by Category</h3>
          {categoryData.length === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>No category data yet</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={categoryData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="total">
                    {categoryData.map((entry, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`${curSym} ${value.toLocaleString()}`, 'Sales']} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ padding: '0 16px' }}>
                {categoryData.map((cat, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[i % COLORS.length] }}></div>
                      <span>{cat.category}</span>
                    </div>
                    <span style={{ fontWeight: 500 }}>{cat.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom Row */}
      <div className="bottom-grid">
        {/* Top Selling Products */}
        <div className="chart-card">
          <h3>Top Selling Products</h3>
          {(data.topProducts || []).length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No sales recorded yet</div>
          ) : (
            data.topProducts.map((product, i) => (
              <div key={i} className="top-product-item">
                <div className="top-product-rank">{i + 1}</div>
                <div className="top-product-info">
                  <h4>{product.product_name}</h4>
                  <p>{product.units_sold} units sold</p>
                </div>
                <div className="top-product-revenue">K {product.revenue?.toLocaleString()}</div>
              </div>
            ))
          )}
        </div>

        {/* Low Stock Alert */}
        <div className="chart-card">
          <h3><FiAlertTriangle style={{ color: '#ca8a04', marginRight: 6 }} /> Low Stock Alert</h3>
          {(data.lowStock || []).length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>All stock levels are healthy</div>
          ) : (
            data.lowStock.map((item, i) => (
              <div key={i} className="low-stock-item">
                <div>
                  <h4>{item.name}</h4>
                  <p>Low stock - reorder soon</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="low-stock-qty">{item.current_stock}</div>
                  <div className="low-stock-unit">{item.unit}</div>
                </div>
              </div>
            ))
          )}
          <button className="view-all-btn" onClick={() => navigate('/stock/inventory')}>View All Inventory</button>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
